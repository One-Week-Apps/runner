import { randomUUID } from "node:crypto";
import { BrainRefusal, KISS_PLAN, type Brain, type Brief, type BrainCapture, type CodeReview, type Lesson, type UxReview } from "../adapters/Brain.js";
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
import { Scheduler } from "../domain/Scheduler.js";

export const VALIDATED_LABEL = "aitasker:validé";
/** Fix rounds the Runner allows itself before delivering, on its own remarks and failing tests. */
export const MAX_INTERNAL_ROUNDS = 2;

export interface IssueLoopConfig {
  label: string;
  allowedAuthors: string[];
  callbackBaseUrl: string;
  /** `merge` absent: trunk-based, the Runner merges after an OK. */
  repos: Record<string, { baseBranch: string; cloneUrl: string; merge?: "trunk" | "pr" }>;
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
  /** Commit subjects of the base written by people: the convention of the merge commit. */
  recentCommits?: string[];
  /** Claude Code did not work at all (usage limit, login…), in its own words. */
  devError?: string | null;
}

/** What the developer reads when Claude Code refused to work: the cause first, in plain words. */
function devRefusal(error: string): string {
  const cause = /usage limit|rate limit|limit reached|quota/i.test(error) ? "limite d'usage de ton compte Claude atteinte"
    : /log ?in|auth|credential|token/i.test(error) ? "Claude Code n'est plus connecté sur ce Mac (lance `claude` pour te reconnecter)"
      : error;
  return `Claude Code n'a pas pu travailler : ${cause}. Rien n'a été modifié. Réponds KO (par exemple « KO relance ») pour relancer quand c'est réglé.`;
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
  /** Why Studio declined part of the current delivery (quota, plan), shown as is in the report. */
  private readonly notices = new Map<string, string>();
  /** Instructions Studio wrote while the task waited: its first attempt starts with them. */
  private readonly prepared = new Map<string, Brief>();
  /** The repository of the last attempt: at equal rank, staying on it saves a clone and a cold build. */
  private lastRepo: string | null = null;

  constructor(private readonly deps: IssueLoopDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.warn = deps.warn ?? ((message, error) => console.warn(`${message}:`, error instanceof Error ? error.message : error));
  }

  async tick(): Promise<void> {
    await this.discover();
    await this.readReplies();
    await this.releaseMerged();
    await this.startNextIfIdle();
    await this.noticeWaiting();
    await this.prepareNext();
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
    if (diff) current = current.changed(changedFiles(diff));
    // Claude Code refused at once (usage limit, login): nothing to review or fix, the developer must know why.
    if (result.devError) {
      this.notices.set(current.key, devRefusal(result.devError));
      await this.deliver(current, result, captures, lostCaptures, null, null);
      await this.discover();
      await this.startNextIfIdle();
      await this.noticeWaiting();
      return;
    }
    // The UX review (the most expensive call) only looks at the task's scenarios, or at everything if none,
    // and only when the developer's plan includes it.
    const ofTask = seen.filter((capture) => capture.forTask);
    const toReview = this.lastBriefs.get(current.key)?.reviews?.ux === false ? [] : (ofTask.length ? ofTask : seen).map(({ forTask: _, ...capture }) => capture);
    const reviewing = !!this.deps.brain && (toReview.length > 0 || !!diff);
    if (reviewing) current = await this.recordStage(current, "review", "started");
    const [ux, code] = await Promise.all([this.reviewOf(current, toReview), this.codeReviewOf(current, diff, result.recentCommits)]);
    if (reviewing) current = await this.recordStage(current, "review", (toReview.length === 0 || ux) && (!diff || code) ? "passed" : "failed");
    this.spend(current.key, "brain", ux?.trace?.costUsd, code?.trace?.costUsd);
    this.spend(current.key, "dev", result.devCostUsd ?? undefined);

    const toFix = Corrections.from(result, ux, code);
    if (toFix.length > 0 && current.canCorrectInternally(MAX_INTERNAL_ROUNDS)) {
      await this.deps.store.save(current.correctInternally(Corrections.feedback(toFix), toFix.map((point) => point.label)));
    } else {
      await this.deliver(current, result, captures, lostCaptures, ux, code);
    }
    await this.discover(); // a task closed during the job must not start
    await this.startNextIfIdle();
    await this.noticeWaiting();
  }

  /** The report goes to the developer; the task then waits for their reply. */
  private async deliver(current: TrackedTask, result: IssueJobResult, captures: ReportCapture[], lostCaptures: number, ux: UxReview | null, code: CodeReview | null): Promise<void> {
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
      ...(this.notices.has(current.key) ? { notice: this.notices.get(current.key) } : {}),
      trace: { brief: this.lastBriefs.get(current.key)?.trace, review: ux?.trace, code: code?.trace },
      cost: this.costs.get(current.key),
      ...(result.relatedBranches?.length ? { relatedBranches: result.relatedBranches } : {}),
      ...(lostCaptures ? { lostCaptures } : {}),
      ...(lesson ? { lesson: { text: lesson.text, scope: lesson.scope } } : {}),
      ...(current.members.length ? { grouped: current.members.map((m) => m.title) } : {}),
    });
    this.costs.delete(current.key);
    this.notices.delete(current.key);
    // A miss means nobody had flagged anything: if a reviewer asked for a fix, the KO proves them right.
    const reviews = [["ux", ux], ["code", code]] as const;
    const ran = reviews.filter(([, review]) => review);
    const approvedBy: Reviewer[] = ran.every(([, review]) => review!.verdict === "ok") ? ran.map(([reviewer]) => reviewer) : [];
    await this.deps.store.save(current.finish({ approvedBy, knowledge: ux?.trace?.knowledge ?? code?.trace?.knowledge, lesson, commit: code?.commit }));
  }

  private async reviewOf(task: TrackedTask, captures: BrainCapture[]): Promise<UxReview | null> {
    if (!this.deps.brain || captures.length === 0) return null;
    try {
      const criteria = this.lastBriefs.get(task.key)?.criteria;
      return await this.deps.brain.review({
        task: task.key, app: appOf(task), title: task.title, body: task.body, captures, followUp: task.tracker.followUp,
        ...(criteria ? { criteria } : {}), ...feedbackOf(task),
      });
    } catch (error) {
      this.failed(task, "UX review", error);
      return null;
    }
  }

  private async codeReviewOf(task: TrackedTask, diff: string | null, recentCommits?: string[]): Promise<CodeReview | null> {
    if (!this.deps.brain || !diff) return null;
    try {
      const criteria = this.lastBriefs.get(task.key)?.criteria;
      return await this.deps.brain.reviewCode({ task: task.key, app: appOf(task), title: task.title, body: task.body, diff, ...feedbackOf(task), ...(criteria ? { criteria } : {}), ...(recentCommits?.length ? { recentCommits } : {}) });
    } catch (error) {
      this.failed(task, "Code review", error);
      return null;
    }
  }

  /** A refusal (quota, plan) is news for the developer; anything else is an outage for the logs. */
  private failed(task: TrackedTask, what: string, error: unknown): void {
    if (error instanceof BrainRefusal) this.notices.set(task.key, error.message);
    else this.warn(`${what} for ${task.key} failed`, error);
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
        task: task.key, app: appOf(task), title: task.title, body: task.body, attempt: task.shownAttempt + 1, feedback: task.lastFeedback,
      });
    } catch (error) {
      this.failed(task, "Instructions", error);
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
        const tracked = tasks.find((t) => t.key === issue.key);
        if (tracked?.is("queued") && tracked.reranked(issue.rank) !== tracked) await this.deps.store.save(tracked.reranked(issue.rank));
        if (known.has(issue.key) || !this.isAllowed(issue.author)) continue;
        await this.deps.store.save(TrackedTask.discover(issue, this.now()));
        known.add(issue.key);
      }
      for (const task of tasks) {
        if (task.tracker.repo !== repo || openKeys.has(task.key) || !this.deps.tracker.tracks(task.key)) continue;
        const abandoned = task.abandon();
        if (abandoned !== task) await this.deps.store.save(abandoned);
        if (abandoned !== task) await this.releaseMembers(abandoned);
      }
    }
  }

  private async readReplies(): Promise<void> {
    for (let task of await this.deps.store.all()) {
      if (!this.deps.tracker.tracks(task.key)) continue;
      if (task.is("queued") && task.pendingQuestion) {
        await this.deps.store.save(await this.readAnswer(task));
        continue;
      }
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
        task: task.key, app: appOf(task), title: task.title, body: task.body, feedback: miss.feedback, reviewers: miss.reviewers,
        source: `${task.key} · ${miss.at.slice(0, 10)}`,
      });
    } catch (error) {
      this.failed(task, "Lesson draft", error);
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

  /** OK: trunk-based by default, the work lands in the base so the next tasks start from it. */
  private async validate(task: TrackedTask): Promise<TrackedTask> {
    const { baseBranch, merge = "trunk" } = this.deps.config.repos[task.tracker.repo];
    if (merge === "pr") {
      const url = await this.deps.tracker.openMergeRequest(task.tracker, task.branch, baseBranch);
      return this.approve(task, `✅ Validé. Le travail est en revue : ${url}`, true);
    }
    const outcome = await this.deps.tracker.merge(task.tracker, task.branch, baseBranch, task.commitSubject);
    if (outcome.status === "behind") {
      const what = outcome.files.length ? `les mêmes fichiers (${outcome.files.map((f) => f.split("/").pop()).join(", ")})` : "le même code";
      await this.deps.tracker.comment(task.tracker, note(
        `🔀 ${baseBranch} a changé ${what} depuis cette tentative. Je remets la tâche à jour par-dessus, je relance le build et les tests, puis je te renvoie le rapport à valider.`,
      ));
      return task.correctInternally(
        `Intègre les derniers changements de ${baseBranch} (déjà fusionnés dans la branche au démarrage) : résous les conflits éventuels en gardant le comportement validé, sans rien changer d'autre.`,
        [`Remis à jour sur ${baseBranch}`],
      );
    }
    return outcome.status === "merged"
      ? this.approve(task, `✅ Validé et fusionné dans ${baseBranch} : ${outcome.url}`)
      : this.approve(task, `✅ Validé. Fusion automatique impossible (${outcome.reason}) : la PR t'attend : ${outcome.url}`, true);
  }

  /** `awaitingMerge`: the pull request waits for the developer, and the task holds its screens and files until then. */
  private async approve(task: TrackedTask, line: string, awaitingMerge = false): Promise<TrackedTask> {
    await this.deps.tracker.addLabel(task.tracker, VALIDATED_LABEL);
    for (const member of (await this.deps.store.all()).filter((t) => t.groupedInto === task.key && t.is("grouped"))) {
      await this.deps.tracker.addLabel(member.tracker, VALIDATED_LABEL);
      await this.deps.tracker.comment(member.tracker, note(`✅ Validé avec « ${task.tracker.title} ».`));
      await this.deps.store.save(member.validate(null, this.now(), awaitingMerge));
    }
    const learned = await this.learn(task);
    const lessonLine = learned
      ? `\n\n📚 Retenu pour ${lessonScope(learned.scope)} : ${learned.text}\nRéponds \`OUBLIE\` pour la retirer.`
      : "";
    await this.deps.tracker.comment(task.tracker, note(`${line}${lessonLine}`));
    return task.validate(learned, this.now(), awaitingMerge);
  }

  /** What the running task touches, from its instructions: the waiting ones are held or grouped against it. */
  private async remember(jobId: string, brief: Brief): Promise<void> {
    if (!brief.footprint) return;
    const running = (await this.deps.store.all()).find((t) => t.runsJob(jobId));
    if (running) await this.deps.store.save(running.preparedWith(brief.footprint, null));
  }

  /** The developer's answer to Studio's question: the task is read again with it before it runs. */
  private async readAnswer(task: TrackedTask): Promise<TrackedTask> {
    for (const reply of await this.deps.tracker.repliesAfter(task.tracker, task.replyCursor)) {
      task = task.readUpTo(reply.id);
      if (!this.isAllowed(reply.author) || reply.body.includes(RUNNER_MARKER)) continue;
      const answer = reply.body.trim().replace(/^(KO|réponse)\s*:?\s*/i, "");
      if (!answer) continue;
      this.prepared.delete(task.key);
      return task.answered(answer);
    }
    return task;
  }

  /** Pull request mode: once the developer merged, the task frees its screens and files. */
  private async releaseMerged(): Promise<void> {
    for (const task of await this.deps.store.all()) {
      if (!task.is("validated") || !task.awaitingMerge || !this.deps.tracker.tracks(task.key)) continue;
      const { baseBranch } = this.deps.config.repos[task.tracker.repo];
      try {
        if (await this.deps.tracker.isMerged(task.tracker, task.branch, baseBranch)) await this.deps.store.save(task.merged());
      } catch (error) {
        this.warn(`Merge check for ${task.key} failed`, error);
      }
    }
  }

  /** The carrying task was closed: its members go back to the queue on their own. */
  private async releaseMembers(carrier: TrackedTask): Promise<void> {
    for (const member of (await this.deps.store.all()).filter((t) => t.groupedInto === carrier.key && t.is("grouped"))) {
      await this.deps.store.save(member.ungroup().waitingFor(null));
    }
  }

  /**
   * While the Runner works, Studio reads the next waiting task: what it will touch (to group or hold it)
   * and, if it is ambiguous, a question for the developer before any attempt. One task per pass.
   */
  private async prepareNext(): Promise<void> {
    if (!this.deps.brain) return;
    const tasks = await this.deps.store.all();
    if (!tasks.some((t) => t.is("running"))) return; // an idle Runner starts the task right away instead
    const next = tasks.find((t) => t.is("queued") && t.attempt === 0 && !t.prepared && this.deps.tracker.tracks(t.key));
    if (!next) return;
    let brief: Brief;
    try {
      brief = await this.deps.brain.brief({ task: next.key, app: appOf(next), title: next.title, body: next.body, attempt: 1, feedback: null });
    } catch (error) {
      this.failed(next, "Preparation", error);
      await this.deps.store.save(next.preparedWith(null, null));
      return;
    }
    this.prepared.set(next.key, brief);
    let prepared = next.preparedWith(brief.footprint ?? null, brief.question ?? null);
    if (brief.question) {
      const asked = await this.deps.tracker.comment(next.tracker, note(`❓ Avant de lancer cette tâche, Studio demande : ${brief.question}\nRéponds en une ligne.`));
      prepared = prepared.readUpTo(asked);
    }
    // The task may have moved meanwhile (closed, answered): only the preparation is added.
    const latest = (await this.deps.store.all()).find((t) => t.key === next.key);
    if (latest?.is("queued") && !latest.prepared) await this.deps.store.save(prepared);
  }

  /** The scheduler's pick (see `Scheduler`); small tasks on the same screen ride along one attempt. */
  private async startNextIfIdle(): Promise<void> {
    const tasks = (await this.deps.store.all()).filter((t) => this.deps.tracker.tracks(t.key));
    const { start } = Scheduler.plan(tasks, this.lastRepo);
    if (!start) return;
    const next = start.task.carrying(start.members);
    for (const member of start.members) {
      const reason = `Regroupée avec « ${next.tracker.title} » : même écran, une seule tentative. Le rapport et ta réponse se font sur « ${next.tracker.title} ».`;
      await this.deps.tracker.showWaiting(member.tracker, reason);
      await this.deps.store.save(member.groupInto(next).waitingFor(reason));
    }
    if (next.waitingShown) await this.deps.tracker.showWaiting(next.tracker, null);
    this.lastRepo = next.tracker.repo;

    const repo = this.deps.config.repos[next.tracker.repo];
    const jobId = randomUUID();
    const retrying = next.lastFeedback !== null;
    // Open the progress thread right away so the developer sees the task start.
    let started = next.start(jobId).waitingFor(null);
    await this.deps.store.save(started);
    if (!started.progressCommentId) {
      const commentId = await this.deps.tracker.showProgress(started.tracker, { attempt: started.shownAttempt, branch: started.branch, progress: {} }, null);
      started = started.tracksProgressIn(commentId);
    }
    // The Mac prepares the repository and simulator while the brain writes the instructions, then fetches
    // them from `instructionsUrl` (without them, the raw task and the KISS plan apply).
    // An internal fix already has precise feedback: it reuses the previous instructions instead of waiting for the brain.
    // A first attempt on its own starts with the instructions Studio wrote while it waited.
    const reused = next.internalRounds > 0 ? this.lastBriefs.get(next.key)
      : next.attempt === 0 && start.members.length === 0 ? this.prepared.get(next.key) : undefined;
    this.prepared.delete(next.key);
    if (this.deps.brain) this.briefs.set(jobId, reused ?? "pending");
    try {
      await this.deps.compute.triggerJob({
        jobId,
        feature: {
          title: `${next.title} (#${next.tracker.number})`,
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
      await this.remember(jobId, reused);
      await this.recordStageOf(jobId, "brief", reused.fallback ? "failed" : "passed");
      return;
    }
    await this.recordStageOf(jobId, "brief", "started");
    const brief = await this.briefFor(next);
    this.briefs.set(jobId, brief);
    await this.remember(jobId, brief);
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
  /** Each waiting task is told why, once per reason: behind the running job, or held by a task touching the same thing. */
  private async noticeWaiting(): Promise<void> {
    const tasks = (await this.deps.store.all()).filter((t) => this.deps.tracker.tracks(t.key));
    const { waiting } = Scheduler.plan(tasks, this.lastRepo);
    const busy = tasks.some((t) => t.is("running"));
    for (const [index, { task, reason }] of waiting.entries()) {
      if (reason) {
        if (task.waitingShown === reason) continue;
        await this.deps.tracker.showWaiting(task.tracker, reason);
        await this.deps.store.save(task.waitingFor(reason));
      } else if (busy && task.needsQueueNotice()) {
        await this.deps.tracker.comment(task.tracker, note(`⏳ En file d'attente (position ${index + 1}) : une autre tâche tourne sur le Mac.`));
        await this.deps.store.save(task.queueNoticed());
      }
    }
  }
}

/** Paths the diff touches ("diff --git a/x b/x"), the Runner's capture helper aside. */
function changedFiles(diff: string): string[] {
  const files = [...diff.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]);
  return [...new Set(files)].filter((f) => !f.endsWith("AITaskerCapture.swift"));
}
