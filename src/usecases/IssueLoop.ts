import { randomUUID } from "node:crypto";
import { KISS_PLAN, type Brain, type Brief, type BrainCapture, type CodeReview, type Lesson, type UxReview } from "../adapters/Brain.js";
import type { Reviewer, ReviewerMiss, ReviewerMisses } from "../adapters/ReviewerMisses.js";
import type { ComputeAgentClient } from "../adapters/ComputeAgentClient.js";
import type { IssueTracker } from "../adapters/IssueTracker.js";
import type { TrackedTaskRepository } from "../adapters/TrackedTaskRepository.js";
import { RUNNER_MARKER, Reply } from "../domain/Reply.js";
import type { ReportCapture } from "../domain/TaskReport.js";
import { TrackedTask } from "../domain/TrackedTask.js";
import { lessonScope } from "../domain/TaskReport.js";
import type { Stage, StageStatus } from "../domain/JobProgress.js";
import { Corrections } from "../domain/Corrections.js";
import { Criteria } from "../domain/Criteria.js";

export const VALIDATED_LABEL = "aitasker:validé";
/** Fix rounds the Runner allows itself before delivering, on its own remarks and failing tests. */
export const MAX_INTERNAL_ROUNDS = 2;

export interface IssueLoopConfig {
  label: string;
  allowedAuthors: string[];
  callbackBaseUrl: string;
  repos: Record<string, { baseBranch: string; cloneUrl: string }>;
  /** Resume Claude Code's session from one run to the next. Off by default: measured more expensive ($0.77–1.07 per resumed run vs ~$0.65 for a fresh one). */
  resumeDevSession?: boolean;
}

export interface IssueJobResult {
  jobId: string;
  outcome: "success" | "failure";
  buildStatus: "pending" | "passed" | "failed";
  testStatus: "pending" | "passed" | "failed";
  nodes: {
    nodeId: string;
    screenshotUrl: string | null;
    action: string | null;
    capturedAt: string;
    scenario?: string | null;
    device?: string | null;
    forTask?: boolean;
    /** What VoiceOver would read on this screen, in order. */
    voiceOver?: string[] | null;
  }[];
  /** "Suite/test (device) : message", so the report can say what breaks. */
  failedTests?: string[];
  /** Tests already failing on the base branch: outside the task's scope. */
  preexistingFailures?: string[];
  /** The task's diff against its base branch, read by the code reviewer. */
  diff?: string | null;
  /** Estimated cost of Claude Code's work on the Mac during this run. */
  devCostUsd?: number | null;
  /** Claude Code session of this run, resumable by the next one. */
  devSessionId?: string | null;
  /** Other unmerged tasks touching the same files. */
  relatedBranches?: { branch: string; files: string[] }[];
}

export interface IssueLoopDeps {
  tracker: IssueTracker;
  compute: ComputeAgentClient;
  store: TrackedTaskRepository;
  config: IssueLoopConfig;
  fetchImage: (url: string) => Promise<Uint8Array>;
  /** Server-side know-how; when absent or failing, the task runs as written and the report has no review. */
  brain?: Brain;
  /** Log of KOs on reports the reviewers had approved. */
  misses?: ReviewerMisses;
  now?: () => string;
  /** Where non-fatal failures (brain down, screenshot refused) are reported. */
  warn?: (message: string, error: unknown) => void;
}

/** Reviewers judge the task as the developer refined it through their KOs. */
function feedbackOf(task: TrackedTask): { feedback?: string } {
  return task.developerFeedback ? { feedback: task.developerFeedback } : {};
}

/** "owner/MyApp" → "MyApp": app lessons are filed under this name. */
function appOf(task: TrackedTask): string {
  return task.tracker.repo.split("/").pop() ?? task.tracker.repo;
}

function note(text: string): string {
  return `${RUNNER_MARKER}\n${text}`;
}

/**
 * Tracker-driven orchestration: discover tasks, run one at a time, publish results and read the
 * OK / KO replies. The domain knows nothing about GitHub or Studio.
 */
export class IssueLoop {
  private readonly now: () => string;
  private readonly warn: (message: string, error: unknown) => void;
  private readonly briefs = new Map<string, Brief | "pending">();
  /** Each task's latest instructions: an internal fix reuses them as is. */
  private readonly lastBriefs = new Map<string, Brief>();
  /** Estimated cost of each task's current delivery, internal fixes included. */
  private readonly costs = new Map<string, { brain: number; dev: number }>();
  /** Lesson being drafted after a miss: written during the next attempt, awaited by its report. */
  private readonly lessonDrafts = new Map<string, Promise<Lesson | null>>();

  constructor(private readonly deps: IssueLoopDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.warn = deps.warn ?? ((message, error) => console.warn(`${message}:`, error instanceof Error ? error.message : error));
  }

  async tick(): Promise<void> {
    await this.discover();
    await this.readReplies();
    await this.startNextIfIdle();
    await this.noticeWaiting();
  }

  /** A job stage started or finished: the progress comment is updated in place. */
  async onProgress(jobId: string, progress: { stage: Stage; status: StageStatus; detail?: string }): Promise<void> {
    const task = (await this.deps.store.all()).find((t) => t.runsJob(jobId));
    if (!task) return;
    await this.recordStage(task, progress.stage, progress.status, progress.detail);
  }

  private async recordStage(task: TrackedTask, stage: Stage, status: StageStatus, detail?: string): Promise<TrackedTask> {
    const updated = task.record(stage, status, this.now(), detail);
    await this.deps.store.save(updated);
    await this.showProgress(updated);
    return updated;
  }

  private async showProgress(task: TrackedTask): Promise<void> {
    if (!task.progressCommentId) return;
    const note = task.internalRounds > 0
      ? `🔁 Correction interne ${task.internalRounds}/${MAX_INTERNAL_ROUNDS} : le Runner corrige ses propres remarques avant de te livrer.`
      : undefined;
    await this.deps.tracker.showProgress(task.tracker, { attempt: task.shownAttempt, branch: task.branch, progress: task.progress, note }, task.progressCommentId);
  }

  async onJobResult(result: IssueJobResult): Promise<void> {
    const tasks = await this.deps.store.all();
    const task = tasks.find((t) => t.runsJob(result.jobId));
    this.briefs.delete(result.jobId);
    if (!task) return;

    const captures: ReportCapture[] = [];
    let lostCaptures = 0;
    const seen: (BrainCapture & { forTask?: boolean })[] = [];
    for (const node of result.nodes) {
      if (!node.screenshotUrl) continue;
      const scenario = node.scenario || "testScenario";
      const device = node.device || "iPhone";
      const path = `issue-${task.tracker.number}/tentative-${task.attempt}/${scenario}/${node.nodeId}-${device.replace(/\s+/g, "_")}.png`;
      let bytes: Uint8Array;
      let imageUrl: string;
      try {
        bytes = await this.deps.fetchImage(node.screenshotUrl);
        imageUrl = await this.deps.tracker.publishImage(task.tracker, path, bytes);
      } catch (error) {
        // A refused screenshot (permissions, network) must neither lose the report nor block the task.
        this.warn(`Screenshot ${path} not published`, error);
        lostCaptures++;
        continue;
      }
      captures.push({ scenario, step: node.nodeId, device, imageUrl, capturedAt: node.capturedAt, forTask: node.forTask, ...(node.voiceOver?.length ? { voiceOver: node.voiceOver } : {}) });
      seen.push({ scenario, step: node.nodeId, device, image: bytes, forTask: node.forTask });
    }

    let current = result.devSessionId ? task.continuesIn(result.devSessionId) : task;
    const diff = result.diff?.trim() ? result.diff : null;
    const reviewing = !!this.deps.brain && (seen.length > 0 || !!diff);
    if (reviewing) current = await this.recordStage(current, "review", "started");
    // The UX review (the most expensive call) only looks at the task's scenarios, or at everything if none.
    const ofTask = seen.filter((capture) => capture.forTask);
    const toReview = (ofTask.length ? ofTask : seen).map(({ forTask: _, ...capture }) => capture);
    const [ux, code] = await Promise.all([this.reviewOf(current, toReview), this.codeReviewOf(current, diff)]);
    if (reviewing) current = await this.recordStage(current, "review", (seen.length === 0 || ux) && (!diff || code) ? "passed" : "failed");
    this.spend(current.key, "brain", ux?.trace?.costUsd, code?.trace?.costUsd);
    this.spend(current.key, "dev", result.devCostUsd ?? undefined);

    const toFix = Corrections.from(result, ux, code);
    if (toFix.length > 0 && current.canCorrectInternally(MAX_INTERNAL_ROUNDS)) {
      await this.deps.store.save(current.correctInternally(Corrections.feedback(toFix), toFix.map((point) => point.label)));
    } else {
      const { repo } = current.tracker;
      const { baseBranch } = this.deps.config.repos[repo];
      const alreadyRed = Corrections.preexisting(result.preexistingFailures ?? [], baseBranch);
      const lesson = await (this.lessonDrafts.get(current.key) ?? Promise.resolve(null));
      this.lessonDrafts.delete(current.key);
      await this.deps.tracker.postReport(current.tracker, {
        attempt: current.shownAttempt, buildStatus: result.buildStatus, testStatus: result.testStatus, captures,
        ux: ux && { verdict: ux.verdict, remarks: ux.remarks.map((remark) => remark.label) },
        codeReview: code && { verdict: code.verdict, remarks: code.remarks.map((remark) => remark.label) },
        failedTests: Corrections.failures(result.failedTests ?? []).map((point) => point.replace(/^Test en échec : /, "")),
        fixedInternally: current.fixedInternally,
        internalRounds: current.internalRounds,
        outOfScope: [
          ...(alreadyRed ? [{ ...alreadyRed, by: "le Runner (tests déjà rouges sur la base)" }] : []),
          ...(ux?.outOfScope ?? []).map((remark) => ({ ...remark, by: "la relecture UX" })),
        ].map(({ label, fix, by }) => ({
          text: label,
          fix,
          newTaskUrl: this.deps.tracker.newTaskUrl(repo, label, `${fix}\n\nRepéré par ${by} sur #${current.tracker.number}.`, this.deps.config.label),
        })),
        codeUrl: this.deps.tracker.codeUrl(current.tracker, current.branch, baseBranch),
        ...(ux?.criteria || code?.criteria ? { criteria: Criteria.merge(ux?.criteria, code?.criteria) } : {}),
        // Instructions lost on the Runner side (brain down) or on the Mac (not received in time): the stage failed.
        fallback: current.progress.brief?.status === "failed",
        trace: { brief: this.lastBriefs.get(current.key)?.trace, review: ux?.trace, code: code?.trace },
        cost: this.costs.get(current.key),
        ...(result.relatedBranches?.length ? { relatedBranches: result.relatedBranches } : {}),
        ...(lostCaptures ? { lostCaptures } : {}),
        ...(lesson ? { lesson: { text: lesson.text, scope: lesson.scope } } : {}),
      });
      this.costs.delete(current.key);
      // A miss means nobody had flagged anything: if a reviewer asked for a fix, the KO proves them right.
      const reviews = [["ux", ux], ["code", code]] as const;
      const ran = reviews.filter(([, review]) => review);
      const approvedBy: Reviewer[] = ran.every(([, review]) => review!.verdict === "ok") ? ran.map(([reviewer]) => reviewer) : [];
      await this.deps.store.save(current.finish({ approvedBy, knowledge: ux?.trace?.knowledge ?? code?.trace?.knowledge, lesson }));
    }
    await this.discover(); // a task closed during the job must not start
    await this.startNextIfIdle();
    await this.noticeWaiting();
  }

  private async reviewOf(task: TrackedTask, captures: BrainCapture[]): Promise<UxReview | null> {
    if (!this.deps.brain || captures.length === 0) return null;
    try {
      const criteria = this.lastBriefs.get(task.key)?.criteria;
      return await this.deps.brain.review({
        app: appOf(task), title: task.tracker.title, body: task.tracker.body, captures, followUp: task.tracker.followUp,
        ...(criteria ? { criteria } : {}), ...feedbackOf(task),
      });
    } catch (error) {
      this.warn(`UX review of ${task.key} failed`, error);
      return null;
    }
  }

  private async codeReviewOf(task: TrackedTask, diff: string | null): Promise<CodeReview | null> {
    if (!this.deps.brain || !diff) return null;
    try {
      const criteria = this.lastBriefs.get(task.key)?.criteria;
      return await this.deps.brain.reviewCode({ app: appOf(task), title: task.tracker.title, body: task.tracker.body, diff, ...feedbackOf(task), ...(criteria ? { criteria } : {}) });
    } catch (error) {
      this.warn(`Code review of ${task.key} failed`, error);
      return null;
    }
  }

  private spend(key: string, on: "brain" | "dev", ...amounts: (number | undefined)[]): void {
    const known = amounts.filter((amount): amount is number => amount !== undefined);
    if (known.length === 0) return;
    const spent = known.reduce((sum, amount) => sum + amount, 0);
    const total = this.costs.get(key) ?? { brain: 0, dev: 0 };
    this.costs.set(key, { ...total, [on]: total[on] + spent });
  }

  /** The brain's instructions and execution plan; failing that, the task as written with the KISS plan. */
  private async briefFor(task: TrackedTask): Promise<Brief> {
    const raw: Brief = { instructions: task.instructions, plan: KISS_PLAN, fallback: true };
    if (!this.deps.brain) return raw;
    try {
      return await this.deps.brain.brief({
        app: appOf(task), title: task.tracker.title, body: task.tracker.body, attempt: task.shownAttempt + 1, feedback: task.lastFeedback,
      });
    } catch (error) {
      this.warn(`Instructions for ${task.key} failed, running the raw task`, error);
      return raw;
    }
  }

  private isAllowed(author: string): boolean {
    return this.deps.config.allowedAuthors.includes(author);
  }

  private async discover(): Promise<void> {
    const tasks = await this.deps.store.all();
    const known = new Set(tasks.map((t) => t.key));
    for (const repo of Object.keys(this.deps.config.repos)) {
      const open = await this.deps.tracker.pendingTasks(repo, this.deps.config.label);
      const openKeys = new Set(open.map((issue) => issue.key));
      for (const issue of open) {
        if (known.has(issue.key) || !this.isAllowed(issue.author)) continue;
        await this.deps.store.save(TrackedTask.discover(issue, this.now()));
        known.add(issue.key);
      }
      for (const task of tasks) {
        if (task.tracker.repo !== repo || openKeys.has(task.key) || !this.deps.tracker.tracks(task.key)) continue;
        const abandoned = task.abandon();
        if (abandoned !== task) await this.deps.store.save(abandoned);
      }
    }
  }

  private async readReplies(): Promise<void> {
    for (let task of await this.deps.store.all()) {
      if (!this.deps.tracker.tracks(task.key)) continue;
      const forgetting = task.is("validated") && task.canForgetAt(this.now());
      if (!task.is("awaiting_reply") && !forgetting) continue;
      for (const reply of await this.deps.tracker.repliesAfter(task.tracker, task.replyCursor)) {
        task = task.readUpTo(reply.id);
        if (!this.isAllowed(reply.author)) continue;
        if (forgetting) {
          if (Reply.wantsToForget(reply.body)) task = await this.forget(task);
          continue;
        }
        const parsed = Reply.parse(reply.body);
        if (!parsed) continue;
        if (parsed.kind === "ok") {
          task = await this.validate(task);
        } else {
          const feedback = Reply.feedbackFor(parsed);
          const miss = task.missedBy(feedback, this.now());
          if (miss) {
            await this.deps.misses?.record(miss);
            this.lessonDrafts.set(task.key, this.draftLesson(task, miss));
          }
          task = task.retry(feedback);
        }
        break;
      }
      await this.deps.store.save(task);
    }
  }

  private async draftLesson(task: TrackedTask, miss: ReviewerMiss): Promise<Lesson | null> {
    if (!this.deps.brain) return null;
    try {
      return await this.deps.brain.proposeLesson({
        app: appOf(task), title: task.tracker.title, body: task.tracker.body, feedback: miss.feedback, reviewers: miss.reviewers,
        source: `${task.key} · ${miss.at.slice(0, 10)}`,
      });
    } catch (error) {
      this.warn(`Lesson draft for ${task.key} failed`, error);
      return null;
    }
  }

  /** OK after a miss: the fix the developer approves confirms the lesson drawn from their feedback. */
  private async learn(task: TrackedTask): Promise<Lesson | null> {
    const lesson = task.proposedLesson;
    if (!lesson || !this.deps.brain) return null;
    try {
      await this.deps.brain.learn(lesson);
      return lesson;
    } catch (error) {
      this.warn(`Learning the lesson for ${task.key} failed`, error);
      return null;
    }
  }

  private async forget(task: TrackedTask): Promise<TrackedTask> {
    const lesson = task.learnedLesson;
    if (!lesson || !this.deps.brain) return task;
    try {
      await this.deps.brain.forget(lesson);
    } catch (error) {
      this.warn(`Forgetting the lesson for ${task.key} failed`, error);
      await this.deps.tracker.comment(task.tracker, note("⚠️ Leçon non retirée : Studio est indisponible. Réessaie avec `OUBLIE`."));
      return task;
    }
    await this.deps.tracker.comment(task.tracker, note(`📚 Leçon oubliée : ${lesson.text}`));
    return task.lessonForgotten();
  }

  private async validate(task: TrackedTask): Promise<TrackedTask> {
    const { baseBranch } = this.deps.config.repos[task.tracker.repo];
    const url = await this.deps.tracker.openMergeRequest(task.tracker, task.branch, baseBranch);
    await this.deps.tracker.addLabel(task.tracker, VALIDATED_LABEL);
    const learned = await this.learn(task);
    const lessonLine = learned
      ? `\n\n📚 Retenu pour ${lessonScope(learned.scope)} : ${learned.text}\nRéponds \`OUBLIE\` pour la retirer.`
      : "";
    await this.deps.tracker.comment(task.tracker, note(`✅ Validé. Le travail est en revue : ${url}${lessonLine}`));
    return task.validate(learned, this.now());
  }

  private async startNextIfIdle(): Promise<void> {
    const tasks = await this.deps.store.all();
    if (tasks.some((t) => t.is("running"))) return;
    // An internal fix goes first: the developer is waiting for its report.
    // Then follow-up tasks (added suggestions): they extend what was just approved.
    const rank = (t: TrackedTask) => (t.internalRounds > 0 ? 2 : t.tracker.followUp ? 1 : 0);
    const queued = tasks.filter((t) => t.is("queued") && this.deps.tracker.tracks(t.key)).sort((a, b) => rank(b) - rank(a));
    const next = queued[0];
    if (!next) return;

    const repo = this.deps.config.repos[next.tracker.repo];
    const jobId = randomUUID();
    const retrying = next.lastFeedback !== null;
    // Open the progress thread right away so the developer sees the task start.
    let started = next.start(jobId);
    await this.deps.store.save(started);
    if (!started.progressCommentId) {
      const commentId = await this.deps.tracker.showProgress(started.tracker, { attempt: started.shownAttempt, branch: started.branch, progress: {} }, null);
      started = started.tracksProgressIn(commentId);
    }
    // The Mac prepares the repository and simulator while the brain writes the instructions, then fetches
    // them from `instructionsUrl` (without them, the raw task and the KISS plan apply).
    // An internal fix already has precise feedback: it reuses the previous instructions instead of waiting for the brain.
    const reused = next.internalRounds > 0 ? this.lastBriefs.get(next.key) : undefined;
    if (this.deps.brain) this.briefs.set(jobId, reused ?? "pending");
    try {
      await this.deps.compute.triggerJob({
        jobId,
        feature: {
          title: `${next.tracker.title} (#${next.tracker.number})`,
          description: next.instructions,
          uiTests: KISS_PLAN.uiTests,
          devices: KISS_PLAN.devices,
          repo: next.tracker.repo,
          cloneUrl: repo.cloneUrl,
          baseBranch: repo.baseBranch,
          branch: next.branch,
          attemptNumber: next.attempt,
          instruction: retrying ? "iteration_feedback" : "initial_dev",
          lastFeedback: next.lastFeedback,
          ...(this.deps.config.resumeDevSession && next.devSession ? { resumeSession: next.devSession } : {}),
        },
        callbackUrl: `${this.deps.config.callbackBaseUrl}/api/issue-jobs/${jobId}/callback`,
        progressUrl: `${this.deps.config.callbackBaseUrl}/api/issue-jobs/${jobId}/progress`,
        ...(this.deps.brain ? { instructionsUrl: `${this.deps.config.callbackBaseUrl}/api/issue-jobs/${jobId}/instructions` } : {}),
      });
    } catch (err) {
      // Compute agent unreachable: the task stays queued and starts again on the next pass.
      this.briefs.delete(jobId);
      await this.deps.store.save(started.progressCommentId ? next.tracksProgressIn(started.progressCommentId) : next);
      throw err;
    }
    await this.deps.store.save(started);
    if (!this.deps.brain) return;
    if (reused) {
      await this.recordStageOf(jobId, "brief", reused.fallback ? "failed" : "passed");
      return;
    }
    await this.recordStageOf(jobId, "brief", "started");
    const brief = await this.briefFor(next);
    this.briefs.set(jobId, brief);
    this.lastBriefs.set(next.key, brief);
    this.spend(next.key, "brain", brief.trace?.costUsd);
    await this.recordStageOf(jobId, "brief", brief.fallback ? "failed" : "passed");
  }

  /** Job progress is written concurrently: always start from the stored state. */
  private async recordStageOf(jobId: string, stage: Stage, status: StageStatus): Promise<void> {
    const task = (await this.deps.store.all()).find((t) => t.runsJob(jobId));
    if (task) await this.recordStage(task, stage, status);
  }

  /** A job's instructions: ready, still being written, or unknown (the job then runs the raw task). */
  instructionsFor(jobId: string): Brief | "pending" | null {
    return this.briefs.get(jobId) ?? null;
  }

  /** A task waiting behind a running job is told so once. */
  private async noticeWaiting(): Promise<void> {
    const tasks = await this.deps.store.all();
    if (!tasks.some((t) => t.is("running"))) return;
    for (const [index, waiting] of tasks.filter((t) => t.is("queued")).entries()) {
      if (!waiting.needsQueueNotice()) continue;
      await this.deps.tracker.comment(waiting.tracker, note(`⏳ En file d'attente (position ${index + 1}) : une autre tâche tourne sur le Mac.`));
      await this.deps.store.save(waiting.queueNoticed());
    }
  }
}
