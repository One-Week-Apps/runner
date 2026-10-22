import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ComputeAgentClient, TriggerJobPayload } from "../src/adapters/ComputeAgentClient.js";
import type { IssueTracker, ProgressView, TrackerReply, TrackerTask } from "../src/adapters/IssueTracker.js";
import { JobProgress } from "../src/domain/JobProgress.js";
import { TaskReport, type ReportInput } from "../src/domain/TaskReport.js";
import { JsonFileTrackedTaskRepository } from "../src/infrastructure/JsonFileTrackedTaskRepository.js";
import { IssueLoop, type IssueLoopConfig } from "../src/usecases/IssueLoop.js";
import { RUNNER_MARKER } from "../src/domain/Reply.js";
import { BrainRefusal, type Brain, type Brief, type BriefRequest, type CodeReview, type CodeReviewRequest, type ExecutionPlan, type Lesson, type LessonRequest, type ReviewRequest, type UxReview } from "../src/adapters/Brain.js";
import type { ReviewerMiss, ReviewerMisses } from "../src/adapters/ReviewerMisses.js";

class FakeTracker implements IssueTracker {
  tracks(key: string): boolean {
    return !key.startsWith("studio:");
  }
  issues: TrackerTask[] = [];
  comments: { key: string; body: string; id: string }[] = [];
  edits: { key: string; id: string; body: string }[] = [];
  replies = new Map<string, TrackerReply[]>();
  images: { key: string; path: string }[] = [];
  mergeRequests: { key: string; branch: string; base: string }[] = [];
  labels: { key: string; label: string }[] = [];

  async pendingTasks(repo: string): Promise<TrackerTask[]> {
    return this.issues.filter((i) => i.repo === repo);
  }
  async comment(task: TrackerTask, markdown: string): Promise<string> {
    const id = `cm${this.comments.length + 1}`;
    this.comments.push({ key: task.key, body: markdown, id });
    return id;
  }
  reports: ReportInput[] = [];
  async showProgress(task: TrackerTask, view: ProgressView, id: string | null): Promise<string> {
    const markdown = JobProgress.render(view.attempt, view.branch, view.progress, view.note);
    if (!id) return this.comment(task, markdown);
    this.edits.push({ key: task.key, id, body: markdown });
    return id;
  }
  async postReport(task: TrackerTask, report: ReportInput): Promise<void> {
    this.reports.push(report);
    await this.comment(task, TaskReport.render(report));
  }
  async publishImage(task: TrackerTask, path: string): Promise<string> {
    this.images.push({ key: task.key, path });
    return `https://hosted/${path}`;
  }
  async repliesAfter(task: TrackerTask, cursor: string | null): Promise<TrackerReply[]> {
    const all = this.replies.get(task.key) ?? [];
    const start = cursor === null ? 0 : all.findIndex((r) => r.id === cursor) + 1;
    return all.slice(start);
  }
  async openMergeRequest(task: TrackerTask, branch: string, base: string): Promise<string> {
    this.mergeRequests.push({ key: task.key, branch, base });
    return `https://pr/${task.number}`;
  }
  async addLabel(task: TrackerTask, label: string): Promise<void> {
    this.labels.push({ key: task.key, label });
  }
  codeUrl(task: TrackerTask, branch: string, base: string): string {
    return `https://code/${task.repo}/${base}...${branch}`;
  }
  newTaskUrl(repo: string, title: string): string {
    return `https://new/${repo}?title=${encodeURIComponent(title)}`;
  }
  close(number: number) {
    this.issues = this.issues.filter((i) => i.number !== number);
  }

  open(number: number, author = "octocat", title = `Tâche ${number}`, body = "") {
    this.issues.push({ key: `One-Week-Apps/EFB#${number}`, repo: "One-Week-Apps/EFB", number, title, body, author, url: `https://gh/${number}` });
  }
  reply(number: number, body: string, author = "octocat") {
    const key = `One-Week-Apps/EFB#${number}`;
    const list = this.replies.get(key) ?? [];
    list.push({ id: `c${list.length + 1}`, author, body });
    this.replies.set(key, list);
  }
  commentsFor(number: number) {
    return this.comments.filter((c) => c.key === `One-Week-Apps/EFB#${number}`).map((c) => c.body);
  }
}

class RecordingCompute implements ComputeAgentClient {
  jobs: TriggerJobPayload[] = [];
  unreachable = false;
  async triggerJob(payload: TriggerJobPayload): Promise<void> {
    if (this.unreachable) throw new Error("Mac de calcul injoignable");
    this.jobs.push(payload);
  }
}

const CONFIG: IssueLoopConfig = {
  label: "aitasker",
  allowedAuthors: ["octocat"],
  callbackBaseUrl: "http://localhost:3939",
  repos: { "One-Week-Apps/EFB": { baseBranch: "chore/xcode27", cloneUrl: "https://github.com/One-Week-Apps/EFB.git" } },
};

/** Fake brain: the external boundary (Claude on the server). */
class FakeBrain implements Brain {
  briefs: BriefRequest[] = [];
  reviews: ReviewRequest[] = [];
  failBrief = false;
  failReview = false;
  review_: UxReview = { verdict: "to_fix", remarks: [{ label: "Le bouton Jouer fait 32 pt : passe-le à 44 pt minimum.", fix: "Le bouton Jouer fait 32 pt : passe-le à 44 pt minimum." }] };

  plan: ExecutionPlan = { uiTests: "task", devices: "main" };
  briefExtras: Partial<Brief> = {};

  async brief(request: BriefRequest): Promise<Brief> {
    this.briefs.push(request);
    if (this.failBrief) throw new Error("cerveau indisponible");
    return { instructions: `CONSIGNES pour « ${request.title} »`, plan: this.plan, ...this.briefExtras };
  }
  async review(request: ReviewRequest): Promise<UxReview> {
    this.reviews.push(request);
    if (this.failReview) throw new Error("cerveau indisponible");
    return this.review_;
  }

  codeReviews: CodeReviewRequest[] = [];
  failCodeReview = false;
  codeReview_: CodeReview = { verdict: "ok", remarks: [] };
  async reviewCode(request: CodeReviewRequest): Promise<CodeReview> {
    this.codeReviews.push(request);
    if (this.failCodeReview) throw new Error("cerveau indisponible");
    return this.codeReview_;
  }

  async proposeLesson(_request: LessonRequest): Promise<Lesson | null> {
    return null;
  }
  async learn(_lesson: Lesson): Promise<void> {}
  async forget(_lesson: Lesson): Promise<void> {}
}

class LearningBrain extends FakeBrain {
  lessonRequests: LessonRequest[] = [];
  learned: Lesson[] = [];
  forgotten: Lesson[] = [];
  lesson_: Lesson | null = { text: "Texte : jamais de lettre coupée en Dynamic Type XXXL", source: "", scope: "" };
  failLesson = false;
  async proposeLesson(request: LessonRequest): Promise<Lesson | null> {
    this.lessonRequests.push(request);
    if (this.failLesson) throw new Error("cerveau indisponible");
    return this.lesson_ && { ...this.lesson_, source: request.source, scope: this.lesson_.scope || request.app };
  }
  async learn(lesson: Lesson): Promise<void> {
    this.learned.push(lesson);
  }
  async forget(lesson: Lesson): Promise<void> {
    this.forgotten.push(lesson);
  }
}

class RecordingMisses implements ReviewerMisses {
  misses: ReviewerMiss[] = [];
  async record(miss: ReviewerMiss): Promise<void> {
    this.misses.push(miss);
  }
}

function setup(brain?: Brain, config: Partial<IssueLoopConfig> = {}) {
  const tracker = new FakeTracker();
  const compute = new RecordingCompute();
  const fetched: string[] = [];
  const misses = new RecordingMisses();
  const warnings: string[] = [];
  const store = new JsonFileTrackedTaskRepository(join(tmpdir(), `aitasker-tasks-${randomUUID()}.json`));
  const loop = new IssueLoop({
    tracker, compute, store, config: { ...CONFIG, ...config }, brain, misses,
    fetchImage: async (url) => { fetched.push(url); return new Uint8Array([1, 2, 3]); },
    now: () => "2026-10-21T18:00:00Z",
    warn: (message) => { warnings.push(message); },
  });
  return { tracker, compute, store, loop, fetched, misses, warnings };
}

const result = (jobId: string, nodes: object[] = []) => ({ jobId, outcome: "success" as const, buildStatus: "passed" as const, testStatus: "passed" as const, nodes: nodes as never });

describe("IssueLoop: an issue becomes a Runner task", () => {
  it("starts a job in a managed clone, on its own branch, for an allowed author's issue", async () => {
    const { tracker, compute, loop } = setup();
    tracker.open(7, "octocat", "Agrandir le bouton Jouer");

    await loop.tick();

    expect(compute.jobs).toHaveLength(1);
    expect(compute.jobs[0].feature).toMatchObject({
      description: "Agrandir le bouton Jouer", repo: "One-Week-Apps/EFB", branch: "aitasker/issue-7",
      baseBranch: "chore/xcode27", cloneUrl: "https://github.com/One-Week-Apps/EFB.git",
      attemptNumber: 0, instruction: "initial_dev", lastFeedback: null,
    });
    expect(compute.jobs[0].callbackUrl).toBe(`http://localhost:3939/api/issue-jobs/${compute.jobs[0].jobId}/callback`);
    expect(compute.jobs[0].progressUrl).toBe(`http://localhost:3939/api/issue-jobs/${compute.jobs[0].jobId}/progress`);
    expect(tracker.commentsFor(7)[0]).toContain(RUNNER_MARKER);
    expect(tracker.commentsFor(7)[0]).toContain("Tentative 1 lancée");
  });

  it("gives Claude Code the issue's title and description", async () => {
    const { tracker, compute, loop } = setup();
    tracker.open(7, "octocat", "Jaune", "Le texte du premier écran doit passer en jaune, pour le contraste.");

    await loop.tick();

    expect(compute.jobs[0].feature.description).toBe("Jaune\n\nLe texte du premier écran doit passer en jaune, pour le contraste.");
  });

  it("updates the progress comment in place instead of adding new ones", async () => {
    const { tracker, compute, loop } = setup();
    tracker.open(7);
    await loop.tick();
    const started = tracker.comments.find((c) => c.body.includes("Tentative 1 lancée"))!;
    const jobId = compute.jobs[0].jobId;

    await loop.onProgress(jobId, { stage: "dev", status: "passed" });
    await loop.onProgress(jobId, { stage: "build", status: "passed" });
    await loop.onProgress(jobId, { stage: "test", status: "started" });

    const last = tracker.edits.at(-1)!;
    expect(last.id).toBe(started.id);
    expect(last.body).toContain(RUNNER_MARKER);
    expect(last.body).toContain("✅ Claude Code");
    expect(last.body).toContain("✅ Build");
    expect(last.body).toContain("⏳ Tests sur simulateur");
    expect(last.body).toContain("⏸ Captures");
    expect(tracker.commentsFor(7)).toHaveLength(1);
  });

  it("keeps the task queued when the compute agent is unreachable and retries in the same thread", async () => {
    const { tracker, compute, loop } = setup();
    tracker.open(7);
    compute.unreachable = true;
    await expect(loop.tick()).rejects.toThrow("injoignable");

    compute.unreachable = false;
    await loop.tick();

    expect(compute.jobs).toHaveLength(1);
    expect(tracker.commentsFor(7)).toHaveLength(1);
    expect(tracker.commentsFor(7)[0]).toContain("Tentative 1 lancée");
  });

  it("ignores progress for an unknown job", async () => {
    const { tracker, loop } = setup();
    await loop.onProgress("inconnu", { stage: "dev", status: "passed" });
    expect(tracker.edits).toHaveLength(0);
  });

  it("ignores issues from other authors, without commenting", async () => {
    const { tracker, compute, loop } = setup();
    tracker.open(8, "quelquun-d-autre");

    await loop.tick();

    expect(compute.jobs).toHaveLength(0);
    expect(tracker.comments).toHaveLength(0);
  });

  it("runs one task at a time and tells the waiting ones once", async () => {
    const { tracker, compute, loop } = setup();
    tracker.open(7);
    tracker.open(9);

    await loop.tick();
    await loop.tick();

    expect(compute.jobs).toHaveLength(1);
    expect(tracker.commentsFor(9)).toHaveLength(1);
    expect(tracker.commentsFor(9)[0]).toContain("En file d'attente");
  });

  it("tells an issue filed during a job that it is waiting", async () => {
    const { tracker, compute, loop } = setup();
    tracker.open(7);
    await loop.tick();

    tracker.open(9);
    await loop.tick();

    expect(compute.jobs).toHaveLength(1);
    expect(tracker.commentsFor(9)).toHaveLength(1);
    expect(tracker.commentsFor(9)[0]).toContain("En file d'attente (position 1)");
  });

  it("publishes screenshots and the report, then starts the next task", async () => {
    const { tracker, compute, loop, fetched } = setup();
    tracker.open(7);
    tracker.open(9);
    await loop.tick();

    await loop.onJobResult(result(compute.jobs[0].jobId, [
      { nodeId: "Accueil", screenshotUrl: "http://localhost:8000/screenshots/j/a.png", action: null, capturedAt: "2026-10-15T10:00:00Z", scenario: "testJouer", device: "iPhone 17e" },
    ]));

    expect(fetched).toEqual(["http://localhost:8000/screenshots/j/a.png"]);
    expect(tracker.images[0].path).toBe("issue-7/tentative-1/testJouer/Accueil-iPhone_17e.png");
    const report = tracker.commentsFor(7).at(-1)!;
    expect(report).toContain("**Tentative 1** · Build ✅ · Tests ✅");
    expect(report).toContain("https://hosted/issue-7/tentative-1/testJouer/Accueil-iPhone_17e.png");
    expect(compute.jobs).toHaveLength(2);
    expect(compute.jobs[1].feature.branch).toBe("aitasker/issue-9");
  });

  it("KO: starts a new attempt on the same branch with the precise feedback", async () => {
    const { tracker, compute, loop } = setup();
    tracker.open(7);
    await loop.tick();
    await loop.onJobResult(result(compute.jobs[0].jobId));

    tracker.reply(7, "KO 1.2 : le bouton est encore trop petit");
    await loop.tick();

    expect(compute.jobs).toHaveLength(2);
    expect(compute.jobs[1].feature).toMatchObject({
      branch: "aitasker/issue-7", attemptNumber: 1, instruction: "iteration_feedback",
      lastFeedback: "Scénario 1, étape 2 : le bouton est encore trop petit",
    });
    expect(tracker.commentsFor(7).at(-1)).toContain("Tentative 2 lancée");
  });

  it("OK: opens the pull request, labels the issue as validated, then stays still", async () => {
    const { tracker, compute, loop } = setup();
    tracker.open(7);
    await loop.tick();
    await loop.onJobResult(result(compute.jobs[0].jobId));

    tracker.reply(7, "OK");
    await loop.tick();
    await loop.tick();

    expect(tracker.mergeRequests).toEqual([{ key: "One-Week-Apps/EFB#7", branch: "aitasker/issue-7", base: "chore/xcode27" }]);
    expect(tracker.labels).toEqual([{ key: "One-Week-Apps/EFB#7", label: "aitasker:validé" }]);
    expect(tracker.commentsFor(7).at(-1)).toContain("https://pr/7");
    expect(compute.jobs).toHaveLength(1);
  });

  it("ignores free-form comments, its own comments and other accounts' comments", async () => {
    const { tracker, compute, loop } = setup();
    tracker.open(7);
    await loop.tick();
    await loop.onJobResult(result(compute.jobs[0].jobId));

    tracker.reply(7, `${RUNNER_MARKER}\nOK`);
    tracker.reply(7, "OK", "quelquun-d-autre");
    tracker.reply(7, "je regarde ce soir");
    await loop.tick();

    expect(compute.jobs).toHaveLength(1);
    expect(tracker.mergeRequests).toHaveLength(0);
  });

  it("never reads the same reply twice, across restarts", async () => {
    const { tracker, compute, store, loop } = setup();
    tracker.open(7);
    await loop.tick();
    await loop.onJobResult(result(compute.jobs[0].jobId));
    tracker.reply(7, "KO : trop petit");
    await loop.tick();
    await loop.onJobResult(result(compute.jobs[1].jobId));

    const restarted = new IssueLoop({ tracker, compute, store, config: CONFIG, fetchImage: async () => new Uint8Array() });
    await restarted.tick();

    expect(compute.jobs).toHaveLength(2);
  });

  it("ignores a result for an unknown job", async () => {
    const { tracker, loop } = setup();
    await loop.onJobResult(result("inconnu"));
    expect(tracker.comments).toHaveLength(0);
  });
});

describe("IssueLoop + brain: the know-how stays on the server, only applied instructions come out", () => {
  const shot = (step: string, device: string, at: string) => ({
    nodeId: step, screenshotUrl: `http://localhost:8000/screenshots/j/${step}-${device}.png`, action: null,
    capturedAt: at, scenario: "testJouer", device,
  });

  it("gives Claude Code the brain's instructions rather than the raw task", async () => {
    const brain = new FakeBrain();
    const { tracker, compute, loop } = setup(brain);
    tracker.open(7, "octocat", "Agrandir le bouton Jouer", "Il est trop petit sur iPhone 17e.");

    await loop.tick();

    expect(brain.briefs[0]).toMatchObject({ title: "Agrandir le bouton Jouer", body: "Il est trop petit sur iPhone 17e.", attempt: 1, feedback: null });
    // The Mac starts right away with the raw task, then reads the instructions once written.
    expect(compute.jobs[0].feature.description).toBe("Agrandir le bouton Jouer\n\nIl est trop petit sur iPhone 17e.");
    expect(compute.jobs[0].instructionsUrl).toBe(`http://localhost:3939/api/issue-jobs/${compute.jobs[0].jobId}/instructions`);
    expect(loop.instructionsFor(compute.jobs[0].jobId)).toMatchObject({ instructions: "CONSIGNES pour « Agrandir le bouton Jouer »" });
    expect(compute.jobs[0].feature.title).toBe("Agrandir le bouton Jouer (#7)");
  });

  it("follows the brain's plan: KISS by default, everything on two screens when it says so", async () => {
    const brain = new FakeBrain();
    const { tracker, compute, loop } = setup(brain);
    tracker.open(7);
    await loop.tick();
    expect(loop.instructionsFor(compute.jobs[0].jobId)).toMatchObject({ plan: { uiTests: "task", devices: "main" } });

    await loop.onJobResult(result(compute.jobs[0].jobId));
    brain.plan = { uiTests: "all", devices: "both" };
    tracker.reply(7, "KO 1.1 : la barre d'onglets a bougé");
    await loop.tick();
    expect(loop.instructionsFor(compute.jobs[1].jobId)).toMatchObject({ plan: { uiTests: "all", devices: "both" } });
  });

  it("sends the feedback and attempt number to the brain after a KO", async () => {
    const brain = new FakeBrain();
    const { tracker, compute, loop } = setup(brain);
    tracker.open(7);
    await loop.tick();
    await loop.onJobResult(result(compute.jobs[0].jobId));
    tracker.reply(7, "KO 1.2 : le bouton est encore trop petit");

    await loop.tick();

    expect(brain.briefs[1]).toMatchObject({ attempt: 2, feedback: "Scénario 1, étape 2 : le bouton est encore trop petit" });
  });

  it("still runs the raw task when the brain is down", async () => {
    const brain = new FakeBrain();
    brain.failBrief = true;
    const { tracker, compute, loop } = setup(brain);
    tracker.open(7, "octocat", "Jaune", "Texte en jaune.");

    await loop.tick();

    expect(compute.jobs[0].feature.description).toBe("Jaune\n\nTexte en jaune.");
  });

  it("adds the brain's UX review of each device's screenshots to the report", async () => {
    const brain = new FakeBrain();
    const { tracker, compute, loop } = setup(brain);
    tracker.open(7, "octocat", "Agrandir le bouton Jouer");
    await loop.tick();

    await loop.onJobResult(result(compute.jobs[0].jobId, [
      shot("Accueil", "iPhone 17e", "2026-10-16T10:00:00Z"),
      shot("Accueil", "iPhone 18 Pro Max", "2026-10-16T10:00:05Z"),
    ]));

    expect(brain.reviews[0].title).toBe("Agrandir le bouton Jouer");
    expect(brain.reviews[0].captures.map((c) => `${c.scenario}/${c.step}/${c.device}`)).toEqual([
      "testJouer/Accueil/iPhone 17e", "testJouer/Accueil/iPhone 18 Pro Max",
    ]);
    expect(brain.reviews[0].captures[0].image).toEqual(new Uint8Array([1, 2, 3]));
    // A remark on the task: the Runner fixes it before delivering.
    expect(compute.jobs).toHaveLength(2);
    expect(compute.jobs[1].feature.lastFeedback).toContain("Le bouton Jouer fait 32 pt : passe-le à 44 pt minimum.");
    expect(tracker.commentsFor(7).join("\n")).not.toContain("👀");
  });

  it("asks for no UX review without screenshots, and reports without it when the brain is down", async () => {
    const brain = new FakeBrain();
    const { tracker, compute, loop } = setup(brain);
    tracker.open(7);
    tracker.open(8);
    await loop.tick();
    await loop.onJobResult(result(compute.jobs[0].jobId));
    expect(brain.reviews).toHaveLength(0);

    brain.failReview = true;
    await loop.onJobResult(result(compute.jobs[1].jobId, [shot("Accueil", "iPhone 17e", "2026-10-16T10:00:00Z")]));

    const report = tracker.commentsFor(8).at(-1)!;
    expect(report).toContain("Tentative 1");
    expect(report).not.toContain("Regard UX");
  });
});

describe("IssueLoop: coordination shows in the report", () => {
  const shot = (step: string, at: string) => ({ nodeId: step, screenshotUrl: `http://mac:8000/screenshots/x/${step}.png`, action: null, capturedAt: at, scenario: "testJouer", device: "iPhone 17e", forTask: true });

  it("shows the brain's done criteria as checked by the UX review", async () => {
    const brain = new FakeBrain();
    brain.briefExtras = { criteria: ["Accueil : titre en Large Title", "Accueil : bouton Jouer visible"] };
    brain.review_ = {
      verdict: "ok", remarks: [],
      criteria: [{ label: "Accueil : titre en Large Title", met: true }, { label: "Accueil : bouton Jouer visible", met: true }],
    };
    const { tracker, compute, loop } = setup(brain);
    tracker.open(7);
    await loop.tick();

    await loop.onJobResult(result(compute.jobs[0].jobId, [shot("Accueil", "2026-10-21T10:00:00Z")]));

    expect(brain.reviews[0].criteria).toEqual(["Accueil : titre en Large Title", "Accueil : bouton Jouer visible"]);
    const report = tracker.commentsFor(7).at(-1)!;
    expect(report).toContain("🎯 **Critères de fini**");
    expect(report).toContain("- ✅ Accueil : titre en Large Title");
  });

  it("traces the knowledge version and model behind each brain call", async () => {
    const brain = new FakeBrain();
    brain.briefExtras = { trace: { knowledge: "a1b2c3d", model: "claude-sonnet-5-5" } };
    brain.review_ = { verdict: "ok", remarks: [], trace: { knowledge: "a1b2c3d", model: "claude-opus-5-5" } };
    const { tracker, compute, loop } = setup(brain);
    tracker.open(7);
    await loop.tick();

    await loop.onJobResult(result(compute.jobs[0].jobId, [shot("Accueil", "2026-10-21T10:00:00Z")]));

    const report = tracker.commentsFor(7).at(-1)!;
    expect(report).toContain("<summary>🧾 Traçabilité</summary>");
    expect(report).toContain("- Consignes : version a1b2c3d · claude-sonnet-5-5");
    expect(report).toContain("- Relecture UX : version a1b2c3d · claude-opus-5-5");
  });

  it("says in progress and report that the raw task was used when the brain failed", async () => {
    const brain = new FakeBrain();
    brain.failBrief = true;
    brain.review_ = { verdict: "ok", remarks: [] };
    const { tracker, compute, loop } = setup(brain);
    tracker.open(7);
    await loop.tick();

    expect(tracker.edits.at(-1)!.body).toContain("❌ Consignes");
    await loop.onJobResult(result(compute.jobs[0].jobId, [shot("Accueil", "2026-10-21T10:00:00Z")]));

    expect(tracker.commentsFor(7).at(-1)!).toContain("⚠️ Consignes non reçues : le Runner est parti de la tâche telle qu'écrite.");
  });

  it("says so in the report when the Mac did not get the instructions in time", async () => {
    const brain = new FakeBrain();
    brain.review_ = { verdict: "ok", remarks: [] };
    const { tracker, compute, loop } = setup(brain);
    tracker.open(7);
    await loop.tick();
    const { jobId } = compute.jobs[0];

    await loop.onProgress(jobId, { stage: "brief", status: "failed" });
    await loop.onJobResult(result(jobId, [shot("Accueil", "2026-10-21T10:00:00Z")]));

    expect(tracker.commentsFor(7).at(-1)!).toContain("⚠️ Consignes non reçues");
  });

  it("shows neither a warning nor an empty trace when instructions arrived", async () => {
    const brain = new FakeBrain();
    brain.review_ = { verdict: "ok", remarks: [] };
    const { tracker, compute, loop } = setup(brain);
    tracker.open(7);
    await loop.tick();

    await loop.onJobResult(result(compute.jobs[0].jobId, [shot("Accueil", "2026-10-21T10:00:00Z")]));

    const report = tracker.commentsFor(7).at(-1)!;
    expect(report).not.toContain("⚠️");
    expect(report).not.toContain("Traçabilité");
    expect(report).not.toContain("Critères de fini");
  });
});

describe("IssueLoop: the report says what breaks", () => {
  it("lists the failing tests named by the compute agent", async () => {
    const { tracker, compute, loop } = setup();
    tracker.open(7);
    await loop.tick();

    const failing = (jobId: string) => ({ ...result(jobId), outcome: "failure" as const, testStatus: "failed" as const, failedTests: ["Suite/test_x (iPhone 17e) : boom"] });
    await loop.onJobResult(failing(compute.jobs[0].jobId));
    expect(compute.jobs[1].feature.lastFeedback).toContain("Test en échec : Suite/test_x (iPhone 17e) : boom");
    await loop.onProgress(compute.jobs[1].jobId, { stage: "dev", status: "started" });
    expect(tracker.edits.at(-1)!.body).toContain("Tentative 1 lancée");
    await loop.onJobResult(failing(compute.jobs[1].jobId));
    await loop.onJobResult(failing(compute.jobs[2].jobId));

    // Two internal rounds were not enough: the report says so.
    expect(compute.jobs).toHaveLength(3);
    const report = tracker.commentsFor(7).at(-1)!;
    expect(report).toContain("Suite/test_x (iPhone 17e) : boom");
    expect(report).toContain("**Tentative 1** · Build ✅ · Tests ❌");
    expect(report).toContain("2 corrections internes avant de te livrer");
  });
});

describe("IssueLoop: the Runner fixes its own remarks before delivering", () => {
  const shot = (step: string, at: string) => ({ nodeId: step, screenshotUrl: `http://mac:8000/screenshots/x/${step}.png`, action: null, capturedAt: at, scenario: "testJouer", device: "iPhone 17e" });

  it("retries on its own for task and harness remarks, in the same thread, then reports once", async () => {
    const brain = new FakeBrain();
    brain.review_ = { verdict: "to_fix", remarks: [{ label: "Version masquée par les tuiles", fix: "Version masquée par les tuiles" }], internal: [{ label: "Capture prise trop tôt", fix: "Capture prise trop tôt" }], outOfScope: [] };
    const { tracker, compute, loop } = setup(brain);
    tracker.open(7);
    await loop.tick();
    const thread = tracker.comments[0].id;

    await loop.onJobResult(result(compute.jobs[0].jobId, [shot("Accueil", "2026-10-17T10:00:00Z")]));

    expect(compute.jobs).toHaveLength(2);
    expect(compute.jobs[1].feature.instruction).toBe("iteration_feedback");
    expect(compute.jobs[1].feature.lastFeedback).toContain("Version masquée par les tuiles");
    expect(compute.jobs[1].feature.lastFeedback).toContain("Capture prise trop tôt");
    // The feedback is already precise: the first run's instructions are reused without asking the brain again.
    expect(brain.briefs).toHaveLength(1);
    expect(loop.instructionsFor(compute.jobs[1].jobId)).toMatchObject({ instructions: "CONSIGNES pour « Tâche 7 »" });
    expect(tracker.commentsFor(7)).toHaveLength(1);
    expect(tracker.edits.at(-1)).toMatchObject({ id: thread });
    expect(tracker.edits.at(-1)!.body).toContain("Tentative 1 lancée");
    expect(tracker.edits.at(-1)!.body).toContain("Correction interne 1/2");

    brain.review_ = { verdict: "ok", remarks: [], internal: [], outOfScope: [{ label: "Titres de chapitres en taille fixe", fix: "Titres de chapitres en taille fixe" }] };
    await loop.onJobResult(result(compute.jobs[1].jobId, [shot("Accueil", "2026-10-17T10:05:00Z")]));

    expect(compute.jobs).toHaveLength(2);
    const report = tracker.commentsFor(7).at(-1)!;
    expect(report).toContain("**Tentative 1** · Build ✅ · Tests ✅ · 1 scénario · 1 correction interne");
    expect(report).toContain("👀 **Relecture UX** : rien à redire.");
    expect(report).toContain("1 correction interne avant de te livrer");
    expect(report).toContain("Version masquée par les tuiles");
    expect(report).toContain("[➕ Ajouter](https://new/One-Week-Apps/EFB?title=Titres%20de%20chapitres%20en%20taille%20fixe)");
  });

  it("resets internal rounds and opens a new thread after a developer KO", async () => {
    const brain = new FakeBrain();
    brain.review_ = { verdict: "ok", remarks: [] };
    const { tracker, compute, loop } = setup(brain);
    tracker.open(7);
    await loop.tick();
    await loop.onJobResult(result(compute.jobs[0].jobId, [shot("Accueil", "2026-10-17T10:00:00Z")]));
    tracker.reply(7, "KO 1.1 : plus grand");

    await loop.tick();

    expect(compute.jobs).toHaveLength(2);
    expect(tracker.commentsFor(7).filter((c) => c.includes("Tentative 2 lancée"))).toHaveLength(1);
  });

  it("numbers the next attempt as the developer sees it after internal fixes", async () => {
    const brain = new FakeBrain();
    brain.review_ = { verdict: "to_fix", remarks: [{ label: "Trop petit", fix: "Trop petit" }] };
    const { tracker, compute, loop } = setup(brain);
    tracker.open(7);
    await loop.tick();
    await loop.onJobResult(result(compute.jobs[0].jobId, [shot("Accueil", "2026-10-17T10:00:00Z")]));
    brain.review_ = { verdict: "ok", remarks: [] };
    await loop.onJobResult(result(compute.jobs[1].jobId, [shot("Accueil", "2026-10-17T10:05:00Z")]));
    tracker.reply(7, "KO 1.1 : encore plus grand");

    await loop.tick();

    expect(tracker.commentsFor(7).at(-1)).toContain("Tentative 2 lancée");
    expect(brain.briefs.at(-1)).toMatchObject({ attempt: 2 });
  });

  it("groups tests failing for the same cause into one item", async () => {
    const { tracker, compute, loop } = setup();
    tracker.open(7);
    await loop.tick();

    await loop.onJobResult({ ...result(compute.jobs[0].jobId), outcome: "failure", testStatus: "failed", failedTests: [
      "A/test_1 (iPhone 17e) : could not dequeue a cell",
      "A/test_2 (iPhone 17e) : could not dequeue a cell",
      "B/test_3 (iPhone 18 Pro Max) : could not dequeue a cell",
      "C/test_4 (iPhone 17e) : boom",
    ] });

    const feedback = compute.jobs[1].feature.lastFeedback!;
    expect(feedback).toContain("3 tests en échec, même cause : could not dequeue a cell (A/test_1, A/test_2, B/test_3)");
    expect(feedback).toContain("Test en échec : C/test_4 (iPhone 17e) : boom");
    expect(feedback.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(2);
  });

  it("shows instructions, each stage's duration and live activity in the progress", async () => {
    const brain = new FakeBrain();
    let clock = Date.parse("2026-10-17T10:00:00Z");
    const tracker = new FakeTracker();
    const compute = new RecordingCompute();
    const store = new JsonFileTrackedTaskRepository(join(tmpdir(), `aitasker-tasks-${randomUUID()}.json`));
    const loop = new IssueLoop({ tracker, compute, store, config: CONFIG, brain, fetchImage: async () => new Uint8Array(), now: () => new Date(clock).toISOString() });
    tracker.open(7);
    await loop.tick();
    const jobId = compute.jobs[0].jobId;

    clock += 5_000;
    await loop.onProgress(jobId, { stage: "dev", status: "started" });
    clock += 20_000;
    await loop.onProgress(jobId, { stage: "dev", status: "started", detail: "2 fichiers modifiés : A.swift, B.swift" });
    expect(tracker.edits.at(-1)!.body).toMatch(/⏳ Claude Code développe · depuis \d\d:\d\d · 2 fichiers modifiés : A.swift, B.swift/);

    clock += 52_000;
    await loop.onProgress(jobId, { stage: "dev", status: "passed" });
    const body = tracker.edits.at(-1)!.body;
    expect(body).toContain("✅ Consignes");
    expect(body).toContain("✅ Claude Code développe · 1 min 12");
    expect(body).toContain("⏸ Relecture UX et code");
  });
});

describe("IssueLoop: closing the issue abandons the task", () => {
  it("drops a queued task whose issue was closed and starts the next one", async () => {
    const { tracker, compute, store, loop } = setup();
    tracker.open(7);
    tracker.open(8);
    await loop.tick();
    tracker.close(8);
    await loop.onJobResult(result(compute.jobs[0].jobId));

    expect(compute.jobs).toHaveLength(1);
    await loop.tick();
    expect(compute.jobs).toHaveLength(1);
    expect((await store.all()).find((t) => t.key.endsWith("#8"))!.is("abandoned")).toBe(true);
  });

  it("stops reading replies for a task whose issue was closed", async () => {
    const { tracker, compute, store, loop } = setup();
    tracker.open(7);
    await loop.tick();
    await loop.onJobResult(result(compute.jobs[0].jobId));
    tracker.close(7);
    await loop.tick();
    tracker.reply(7, "KO : trop tard");

    await loop.tick();

    expect(compute.jobs).toHaveLength(1);
    expect((await store.all())[0].is("abandoned")).toBe(true);
  });

  it("lets a running job finish even if its issue is closed meanwhile", async () => {
    const { tracker, store, loop } = setup();
    tracker.open(7);
    await loop.tick();
    tracker.close(7);

    await loop.tick();

    expect((await store.all())[0].is("running")).toBe(true);
  });
});

describe("IssueLoop: the report links to the code", () => {
  it("links the report to the attempt's diff", async () => {
    const { tracker, compute, loop } = setup();
    tracker.open(7);
    await loop.tick();

    await loop.onJobResult(result(compute.jobs[0].jobId));

    expect(tracker.commentsFor(7).at(-1)).toContain("https://code/One-Week-Apps/EFB/chore/xcode27...aitasker/issue-7");
  });
});

describe("IssueLoop: work batches", () => {
  it("shows the short label and sends the decided fix to Claude Code", async () => {
    const brain = new FakeBrain();
    brain.review_ = { verdict: "to_fix", remarks: [{ label: "Accueil : titre trop petit", fix: "Titre en Large Title, 34 pt gras" }] };
    const { tracker, compute, loop } = setup(brain);
    tracker.open(7);
    await loop.tick();

    await loop.onJobResult(result(compute.jobs[0].jobId, [{ nodeId: "Accueil", screenshotUrl: "u", action: null, capturedAt: "t" }]));

    expect(compute.jobs[1].feature.lastFeedback).toContain("Accueil : titre trop petit → Titre en Large Title, 34 pt gras");
  });

  it("runs a follow-up task before other queued tasks", async () => {
    const { tracker, compute, loop } = setup();
    tracker.open(7);
    tracker.open(8);
    tracker.issues.push({ key: "One-Week-Apps/EFB#9", repo: "One-Week-Apps/EFB", number: 9, title: "Suites", body: "", author: "octocat", url: "u", followUp: true });
    await loop.tick();

    expect(compute.jobs[0].feature.branch).toBe("aitasker/issue-9");
    await loop.onJobResult(result(compute.jobs[0].jobId));
    expect(compute.jobs[1].feature.branch).toBe("aitasker/issue-7");
  });
});

describe("Corrections: what the developer reads stays short", () => {
  it("gives a short label for a broken build or failing tests, and the details to Claude Code", async () => {
    const { Corrections } = await import("../src/domain/Corrections.js");
    const points = Corrections.from({ buildStatus: "failed", testStatus: "failed", failedTests: [
      "Suite/testA (iPhone 17e) : crash", "Suite/testB (iPhone 17e) : crash", "Suite/testC (iPhone 17e) : texte absent",
    ] }, null);
    expect(points.map((p) => p.label)).toEqual(["Build cassé", "Tests : 2 en échec", "Test en échec"]);
    expect(points[1].fix).toContain("même cause : crash");
  });
});


describe("IssueLoop: a dedicated code reviewer before the developer", () => {
  const shot = { nodeId: "Accueil", screenshotUrl: "http://mac:8000/screenshots/x/a.png", action: null, capturedAt: "2026-10-21T10:00:00Z", scenario: "testJouer", device: "iPhone 17e", forTask: true };
  const DIFF = "diff --git a/Title.swift b/Title.swift\n+ .strokeWidth(-3)";
  const withDiff = (jobId: string) => ({ ...result(jobId, [shot]), diff: DIFF });

  it("has the code reviewer read the diff, not the screenshots", async () => {
    const brain = new FakeBrain();
    brain.review_ = { verdict: "ok", remarks: [] };
    const { tracker, compute, loop } = setup(brain);
    tracker.open(7, "octocat", "Titre en gras", "Luciole en gras");
    await loop.tick();

    await loop.onJobResult(withDiff(compute.jobs[0].jobId));

    expect(brain.codeReviews).toEqual([{ task: "One-Week-Apps/EFB#7", app: "EFB", title: "Titre en gras", body: "Luciole en gras", diff: DIFF }]);
    expect(tracker.commentsFor(7).at(-1)!).toContain("🔍 **Revue de code** : rien à redire.");
  });

  it("fixes a hack spotted in the code before delivering", async () => {
    const brain = new FakeBrain();
    brain.review_ = { verdict: "ok", remarks: [] };
    brain.codeReview_ = { verdict: "to_fix", remarks: [{ label: "Titre : faux gras", fix: "Ajoute la vraie fonte Luciole Bold au projet, retire le contour." }] };
    const { tracker, compute, loop } = setup(brain);
    tracker.open(7);
    await loop.tick();

    await loop.onJobResult(withDiff(compute.jobs[0].jobId));

    expect(compute.jobs).toHaveLength(2);
    expect(compute.jobs[1].feature.lastFeedback).toContain("Titre : faux gras → Ajoute la vraie fonte Luciole Bold au projet, retire le contour.");
    expect(tracker.reports).toHaveLength(0);
  });

  it("reports what the code reviewer still objects to", async () => {
    const brain = new FakeBrain();
    brain.review_ = { verdict: "ok", remarks: [] };
    brain.codeReview_ = { verdict: "to_fix", remarks: [{ label: "Titre : faux gras", fix: "Vraie fonte" }] };
    const { tracker, compute, loop } = setup(brain);
    tracker.open(7);
    await loop.tick();

    for (let round = 0; round <= 2; round++) await loop.onJobResult(withDiff(compute.jobs[round].jobId));

    const report = tracker.commentsFor(7).at(-1)!;
    expect(report).toContain("🔍 **Revue de code** : à corriger");
    expect(report).toContain("- Titre : faux gras");
  });

  it("skips the code review without a diff", async () => {
    const brain = new FakeBrain();
    brain.review_ = { verdict: "ok", remarks: [] };
    const { tracker, compute, loop } = setup(brain);
    tracker.open(7);
    await loop.tick();

    await loop.onJobResult(result(compute.jobs[0].jobId, [shot]));

    expect(brain.codeReviews).toHaveLength(0);
    expect(tracker.commentsFor(7).at(-1)!).not.toContain("Revue de code");
  });

  it("delivers without the code review line when the reviewer is down", async () => {
    const brain = new FakeBrain();
    brain.review_ = { verdict: "ok", remarks: [] };
    brain.failCodeReview = true;
    const { tracker, compute, loop } = setup(brain);
    tracker.open(7);
    await loop.tick();

    await loop.onJobResult(withDiff(compute.jobs[0].jobId));

    expect(tracker.reports).toHaveLength(1);
    expect(tracker.commentsFor(7).at(-1)!).not.toContain("Revue de code");
  });

  it("adds up brain calls and Claude Code's work into the task's estimated cost", async () => {
    const brain = new FakeBrain();
    brain.briefExtras = { trace: { knowledge: "a1b2c3d", model: "sonnet", costUsd: 0.1 } };
    brain.review_ = { verdict: "ok", remarks: [], trace: { knowledge: "a1b2c3d", model: "opus", costUsd: 0.2 } };
    brain.codeReview_ = { verdict: "ok", remarks: [], trace: { knowledge: "a1b2c3d", model: "opus", costUsd: 0.05 } };
    const { tracker, compute, loop } = setup(brain);
    tracker.open(7);
    await loop.tick();

    await loop.onJobResult({ ...withDiff(compute.jobs[0].jobId), devCostUsd: 1.5 });

    const report = tracker.commentsFor(7).at(-1)!;
    expect(report).toContain("- Relecture du code : version a1b2c3d · opus");
    expect(report).toContain("- Coût estimé : 1,85 $ (Studio 0,35 $ · Claude Code 1,50 $)");
  });
});

describe("IssueLoop: reviewer reliability is measured", () => {
  const shot = { nodeId: "Accueil", screenshotUrl: "http://mac:8000/screenshots/x/a.png", action: null, capturedAt: "2026-10-21T10:00:00Z", scenario: "testJouer", device: "iPhone 17e", forTask: true };

  it("records a KO after an approving review as a reviewer miss, with the feedback", async () => {
    const brain = new FakeBrain();
    brain.review_ = { verdict: "ok", remarks: [], trace: { knowledge: "a1b2c3d", model: "opus" } };
    const { tracker, compute, loop, misses } = setup(brain);
    tracker.open(7, "octocat", "Titre en gras");
    await loop.tick();
    await loop.onJobResult({ ...result(compute.jobs[0].jobId, [shot]), diff: "diff" });

    tracker.reply(7, "KO 1.1 : le point du i est coupé");
    await loop.tick();

    expect(misses.misses).toEqual([{
      at: "2026-10-21T18:00:00Z", task: "One-Week-Apps/EFB#7", title: "Titre en gras", attempt: 1,
      feedback: "Scénario 1, étape 1 : le point du i est coupé", reviewers: ["ux", "code"], knowledge: "a1b2c3d",
    }]);
  });

  it("does not count a KO on a report already flagged as a miss", async () => {
    const brain = new FakeBrain();
    const { tracker, compute, loop, misses } = setup(brain);
    tracker.open(7);
    tracker.open(8);
    brain.review_ = { verdict: "ok", remarks: [] };
    await loop.tick();
    await loop.onJobResult(result(compute.jobs[0].jobId, [shot]));
    brain.review_ = { verdict: "to_fix", remarks: [{ label: "Accueil : titre trop petit", fix: "Large Title" }] };
    for (let round = 1; round <= 3; round++) await loop.onJobResult(result(compute.jobs[round].jobId, [shot]));

    tracker.reply(7, "OK");
    tracker.reply(8, "KO : titre trop petit");
    await loop.tick();

    expect(misses.misses).toEqual([]);
  });
});

describe("IssueLoop: the brain learns from its misses", () => {
  const shot = { nodeId: "Accueil", screenshotUrl: "http://mac:8000/screenshots/x/a.png", action: null, capturedAt: "2026-10-21T10:00:00Z", scenario: "testJouer", device: "iPhone 17e", forTask: true };

  async function missedOnce(brain: LearningBrain) {
    brain.review_ = { verdict: "ok", remarks: [] };
    const env = setup(brain);
    env.tracker.open(7, "octocat", "Titre en gras");
    await env.loop.tick();
    await env.loop.onJobResult(result(env.compute.jobs[0].jobId, [shot]));
    env.tracker.reply(7, "KO 1.1 : le point du i est coupé");
    await env.loop.tick();
    return env;
  }

  it("announces in the next report what the brain will learn on approval", async () => {
    const brain = new LearningBrain();
    const { tracker, compute, loop } = await missedOnce(brain);

    await loop.onJobResult(result(compute.jobs[1].jobId, [shot]));

    expect(brain.lessonRequests).toEqual([{ task: "One-Week-Apps/EFB#7", app: "EFB", title: "Titre en gras", body: "", feedback: "Scénario 1, étape 1 : le point du i est coupé", reviewers: ["ux"], source: "One-Week-Apps/EFB#7 · 2026-10-21" }]);
    expect(tracker.commentsFor(7).at(-1)!).toContain("📚 Si tu valides, Studio retiendra pour EFB : Texte : jamais de lettre coupée en Dynamic Type XXXL");
  });

  it("learns the lesson on OK after a miss, and OUBLIE removes it", async () => {
    const brain = new LearningBrain();
    const { tracker, compute, loop } = await missedOnce(brain);
    await loop.onJobResult(result(compute.jobs[1].jobId, [shot]));

    tracker.reply(7, "OK");
    await loop.tick();

    expect(brain.learned).toEqual([{ text: "Texte : jamais de lettre coupée en Dynamic Type XXXL", source: "One-Week-Apps/EFB#7 · 2026-10-21", scope: "EFB" }]);
    const validated = tracker.commentsFor(7).at(-1)!;
    expect(validated).toContain("✅ Validé");
    expect(validated).toContain("📚 Retenu pour EFB : Texte : jamais de lettre coupée en Dynamic Type XXXL");
    expect(validated).toContain("`OUBLIE`");

    tracker.reply(7, "OUBLIE");
    await loop.tick();
    expect(brain.forgotten).toEqual(brain.learned);
    expect(tracker.commentsFor(7).at(-1)!).toContain("📚 Leçon oubliée");

    tracker.reply(7, "oublie");
    await loop.tick();
    expect(brain.forgotten).toHaveLength(1);
  });

  it("learns a lesson for all apps when it matches another app's lesson", async () => {
    const brain = new LearningBrain();
    brain.lesson_ = { text: "VoiceOver : un texte n'est jamais un bouton", source: "", scope: "all" };
    const { tracker, compute, loop } = await missedOnce(brain);
    await loop.onJobResult(result(compute.jobs[1].jobId, [shot]));
    expect(tracker.commentsFor(7).at(-1)!).toContain("📚 Si tu valides, Studio retiendra pour toutes tes apps : VoiceOver : un texte n'est jamais un bouton");

    tracker.reply(7, "OK");
    await loop.tick();

    expect(tracker.commentsFor(7).at(-1)!).toContain("📚 Retenu pour toutes tes apps");
  });

  it("replaces the lesson on a new KO, and learns nothing when the task is abandoned", async () => {
    const brain = new LearningBrain();
    const { tracker, compute, loop } = await missedOnce(brain);
    await loop.onJobResult(result(compute.jobs[1].jobId, [shot]));

    tracker.reply(7, "KO : toujours coupé");
    await loop.tick();
    tracker.close(7);
    await loop.tick();

    expect(brain.learned).toEqual([]);
  });

  it("reports without a lesson when the brain is down, and proposes one on the next miss", async () => {
    const brain = new LearningBrain();
    brain.failLesson = true;
    const { tracker, compute, loop } = await missedOnce(brain);

    await loop.onJobResult(result(compute.jobs[1].jobId, [shot]));
    expect(tracker.commentsFor(7).at(-1)!).not.toContain("📚");

    brain.failLesson = false;
    tracker.reply(7, "KO : encore coupé");
    await loop.tick();
    await loop.onJobResult(result(compute.jobs[2].jobId, [shot]));
    expect(brain.lessonRequests).toHaveLength(2);
  });
});
describe("IssueLoop: a test already failing before the task is not the task's problem", () => {
  it("does not fix it internally but offers a task to repair it", async () => {
    const { tracker, compute, loop } = setup();
    tracker.open(7);
    await loop.tick();

    await loop.onJobResult({ ...result(compute.jobs[0].jobId), preexistingFailures: ["HomeVersionLabelTests/test_version (iPhone 17e) : XCTAssertTrue failed", "LoadLevelTests/test_subtitle (iPhone 17e) : XCTAssertTrue failed"] });

    expect(compute.jobs).toHaveLength(1);
    const report = tracker.commentsFor(7).at(-1)!;
    expect(report).toContain("Tests ✅");
    expect(report).toContain("- Tests : 2 déjà en échec avant la tâche · [➕ Ajouter]");
    expect(decodeURIComponent(report)).toContain("title=Tests : 2 déjà en échec avant la tâche");
  });
});

describe("IssueLoop: a miss only counts when nobody had flagged anything", () => {
  it("records no miss when the code reviewer had asked for a fix", async () => {
    const brain = new FakeBrain();
    brain.review_ = { verdict: "ok", remarks: [] };
    brain.codeReview_ = { verdict: "to_fix", remarks: [{ label: "Tests : lisent les fichiers", fix: "Teste l'écran" }] };
    const { tracker, compute, loop, misses } = setup(brain);
    tracker.open(7);
    await loop.tick();
    const shot = { nodeId: "Accueil", screenshotUrl: "http://mac/a.png", action: null, capturedAt: "t", scenario: "testJouer", device: "iPhone 17e" };
    for (let round = 0; round <= 2; round++) await loop.onJobResult({ ...result(compute.jobs[round].jobId, [shot]), diff: "d" });
    expect(brain.reviews).toHaveLength(3);

    tracker.reply(7, "KO : teste l'écran, pas les fichiers");
    await loop.tick();

    expect(misses.misses).toEqual([]);
  });
});

describe("IssueLoop: reviewers judge the task with the developer's feedback", () => {
  it("passes the KO feedback to both reviewers, internal fixes included", async () => {
    const brain = new FakeBrain();
    brain.review_ = { verdict: "ok", remarks: [] };
    const shot = { nodeId: "Accueil", screenshotUrl: "http://mac/a.png", action: null, capturedAt: "t", scenario: "testJouer", device: "iPhone 17e" };
    const { tracker, compute, loop } = setup(brain);
    tracker.open(7);
    await loop.tick();
    await loop.onJobResult({ ...result(compute.jobs[0].jobId, [shot]), diff: "d" });
    tracker.reply(7, "KO : le paragraphe n'est pas un bouton");
    await loop.tick();

    brain.codeReview_ = { verdict: "to_fix", remarks: [{ label: "Tests : faibles", fix: "f" }] };
    await loop.onJobResult({ ...result(compute.jobs[1].jobId, [shot]), diff: "d" });
    await loop.onJobResult({ ...result(compute.jobs[2].jobId, [shot]), diff: "d" });

    expect(brain.codeReviews[0].feedback).toBeUndefined();
    expect(brain.codeReviews[1].feedback).toBe("le paragraphe n'est pas un bouton");
    expect(brain.codeReviews[2].feedback).toBe("le paragraphe n'est pas un bouton");
    expect(brain.reviews[2].feedback).toBe("le paragraphe n'est pas un bouton");
  });
});

describe("IssueLoop: each done criterion is checked where it shows", () => {
  const shot = { nodeId: "Instructions", screenshotUrl: "http://mac/a.png", action: null, capturedAt: "t", scenario: "testRejouer", device: "iPhone 17e" };

  it("checks a criterion invisible on screenshots in the code instead of failing it", async () => {
    const brain = new FakeBrain();
    brain.briefExtras = { criteria: ["Instructions : paragraphe lu comme texte", "Instructions : indice VoiceOver sur Rejouer"] };
    brain.review_ = { verdict: "ok", remarks: [], criteria: [
      { label: "Instructions : paragraphe lu comme texte", met: true },
      { label: "Instructions : indice VoiceOver sur Rejouer" },
    ] };
    brain.codeReview_ = { verdict: "ok", remarks: [], criteria: [{ label: "Instructions : indice VoiceOver sur Rejouer", met: true }] };
    const { tracker, compute, loop } = setup(brain);
    tracker.open(7);
    await loop.tick();

    await loop.onJobResult({ ...result(compute.jobs[0].jobId, [shot]), diff: "d" });

    expect(brain.codeReviews[0].criteria).toEqual(["Instructions : paragraphe lu comme texte", "Instructions : indice VoiceOver sur Rejouer"]);
    const report = tracker.commentsFor(7).at(-1)!;
    expect(report).toContain("- ✅ Instructions : paragraphe lu comme texte");
    expect(report).toContain("- ✅ Instructions : indice VoiceOver sur Rejouer · vu dans le code");
    expect(compute.jobs).toHaveLength(1);
  });

  it("flags a criterion nobody can check, without failing it", async () => {
    const brain = new FakeBrain();
    brain.briefExtras = { criteria: ["Instructions : indice traduit"] };
    brain.review_ = { verdict: "ok", remarks: [], criteria: [{ label: "Instructions : indice traduit" }] };
    const { tracker, compute, loop } = setup(brain);
    tracker.open(7);
    await loop.tick();

    await loop.onJobResult(result(compute.jobs[0].jobId, [shot]));

    expect(tracker.commentsFor(7).at(-1)!).toContain("- ❔ Instructions : indice traduit · non vérifiable");
  });
});

describe("IssueLoop: Claude Code can resume its session across attempts", () => {
  it("resumes the previous session on internal fixes and KOs when enabled, starting fresh the first time", async () => {
    const { tracker, compute, loop } = setup(undefined, { resumeDevSession: true });
    tracker.open(7);
    await loop.tick();
    expect(compute.jobs[0].feature.resumeSession).toBeUndefined();

    await loop.onJobResult({ ...result(compute.jobs[0].jobId), buildStatus: "failed", devSessionId: "s1" });
    expect(compute.jobs[1].feature.resumeSession).toBe("s1");

    await loop.onJobResult({ ...result(compute.jobs[1].jobId), devSessionId: "s2" });
    tracker.reply(7, "KO : encore trop petit");
    await loop.tick();
    expect(compute.jobs[2].feature.resumeSession).toBe("s2");
  });

  it("forgets the session once the task is validated", async () => {
    const { tracker, compute, loop, store } = setup();
    tracker.open(7);
    await loop.tick();
    await loop.onJobResult({ ...result(compute.jobs[0].jobId), devSessionId: "s1" });
    tracker.reply(7, "OK");
    await loop.tick();

    expect((await store.all())[0].toJSON().devSession ?? null).toBeNull();
  });
});

describe("IssueLoop: the UX review only looks at what the task touched", () => {
  const shot = (scenario: string, step: string, forTask: boolean) => ({ nodeId: step, screenshotUrl: `http://mac/${scenario}-${step}.png`, action: null, capturedAt: step, scenario, device: "iPhone 17e", forTask });

  it("reviews only the task's scenarios while the report keeps every screenshot", async () => {
    const brain = new FakeBrain();
    brain.review_ = { verdict: "ok", remarks: [] };
    const { tracker, compute, loop } = setup(brain);
    tracker.open(7);
    await loop.tick();

    await loop.onJobResult(result(compute.jobs[0].jobId, [shot("testAutre", "Accueil", false), shot("testTache", "Accueil", true), shot("testTache", "Niveau", true)]));

    expect(brain.reviews[0].captures.map((c) => `${c.scenario}/${c.step}`)).toEqual(["testTache/Accueil", "testTache/Niveau"]);
    expect(tracker.reports[0].captures).toHaveLength(3);
  });

  it("reviews everything when the task has no scenario of its own", async () => {
    const brain = new FakeBrain();
    brain.review_ = { verdict: "ok", remarks: [] };
    const { tracker, compute, loop } = setup(brain);
    tracker.open(7);
    await loop.tick();

    await loop.onJobResult(result(compute.jobs[0].jobId, [shot("testA", "Accueil", false), shot("testB", "Niveau", false)]));

    expect(brain.reviews[0].captures).toHaveLength(2);
  });
});

describe("IssueLoop: a refused screenshot does not lose the report", () => {
  it("reports without it, with a warning, and waits for the reply", async () => {
    const brain = new FakeBrain();
    brain.review_ = { verdict: "ok", remarks: [] };
    const { tracker, compute, loop, store } = setup(brain);
    tracker.publishImage = async () => { throw new Error("Studio 403: Permission denied."); };
    tracker.open(7);
    await loop.tick();

    await loop.onJobResult(result(compute.jobs[0].jobId, [{ nodeId: "Accueil", screenshotUrl: "http://mac/a.png", action: null, capturedAt: "t", scenario: "testJouer", device: "iPhone 17e" }]));

    expect(tracker.reports).toHaveLength(1);
    expect(tracker.reports[0].captures).toEqual([]);
    expect(tracker.commentsFor(7).at(-1)!).toContain("⚠️ 1 capture non publiée");
    expect((await store.all())[0].is("awaiting_reply")).toBe(true);
  });
});

describe("IssueLoop: by default, each run starts a fresh session", () => {
  it("does not resume the known session without the option", async () => {
    const { tracker, compute, loop } = setup();
    tracker.open(7);
    await loop.tick();
    await loop.onJobResult({ ...result(compute.jobs[0].jobId), buildStatus: "failed", devSessionId: "s1" });
    expect(compute.jobs[1].feature.resumeSession).toBeUndefined();
  });
});

describe("TrackedTask: one branch per task, even across Studio accounts", () => {
  it("gives task #1 of two different accounts different branches", async () => {
    const { TrackedTask } = await import("../src/domain/TrackedTask.js");
    const studio = (id: string) => TrackedTask.discover({ key: `studio:${id}`, repo: "o/r", number: 1, title: "t", body: "", author: "u", url: "" }, "t");

    expect(studio("rE2GueYgUyE5NfOppnkZ").branch).toBe("aitasker/tache-1-re2gue");
    expect(studio("E3QPQxn5sUtKLvggS9TS").branch).toBe("aitasker/tache-1-e3qpqx");
    expect(TrackedTask.discover({ key: "o/r#7", repo: "o/r", number: 7, title: "t", body: "", author: "u", url: "" }, "t").branch).toBe("aitasker/issue-7");
  });
});

describe("IssueLoop: the report flags related unmerged work", () => {
  it("shows one line per branch with the shared files", async () => {
    const { tracker, compute, loop } = setup();
    tracker.open(7);
    await loop.tick();

    await loop.onJobResult({ ...result(compute.jobs[0].jobId), relatedBranches: [{ branch: "aitasker/issue-13", files: ["LoadLevelViewController.swift"] }] });

    expect(tracker.commentsFor(7).at(-1)!).toContain("🔀 **Pas encore fusionné, touche les mêmes fichiers** : aitasker/issue-13 (LoadLevelViewController.swift)");
  });
});

describe("IssueLoop: switching trackers does not abandon the other tracker's tasks", () => {
  it("leaves a waiting Studio task alone while polling GitHub", async () => {
    const { tracker, loop, store } = setup();
    const { TrackedTask } = await import("../src/domain/TrackedTask.js");
    await store.save(TrackedTask.discover({ key: "studio:abc", repo: "One-Week-Apps/EFB", number: 1, title: "t", body: "", author: "u", url: "" }, "t"));
    tracker.open(7);

    await loop.tick();

    expect((await store.all()).find((t) => t.key === "studio:abc")!.is("abandoned")).toBe(false);
  });
});

describe("IssueLoop: Studio plans and quotas", () => {
  const shot = { nodeId: "Accueil", screenshotUrl: "http://mac/a.png", action: null, capturedAt: "t", scenario: "testJouer", device: "iPhone 17e", forTask: true };

  it("runs the raw task when the quota is reached and tells the developer why, without logging an outage", async () => {
    const brain = new FakeBrain();
    const quota = "Quota du mois atteint (30/30 tâches) : tâche faite sans Studio. Renouvellement le 1er novembre.";
    brain.brief = async (request) => { brain.briefs.push(request); throw new BrainRefusal(quota); };
    const { tracker, compute, loop, warnings } = setup(brain);
    tracker.open(7, "octocat", "Agrandir le bouton Jouer");
    await loop.tick();

    expect(loop.instructionsFor(compute.jobs[0].jobId)).toMatchObject({ fallback: true });
    await loop.onJobResult(result(compute.jobs[0].jobId));

    expect(brain.briefs[0].task).toBe("One-Week-Apps/EFB#7");
    expect(tracker.commentsFor(7).at(-1)!).toContain(`ℹ️ ${quota}`);
    expect(tracker.commentsFor(7).at(-1)!).not.toContain("Consignes non reçues");
    expect(warnings.filter((w) => w.startsWith("Instructions"))).toEqual([]);
  });

  it("skips the UX review when the plan does not include it, and still reviews the code", async () => {
    const brain = new FakeBrain();
    brain.briefExtras = { reviews: { ux: false } };
    const { tracker, compute, loop } = setup(brain);
    tracker.open(7);
    await loop.tick();

    await loop.onJobResult({ ...result(compute.jobs[0].jobId, [shot]), diff: "+ a" });

    expect(brain.reviews).toEqual([]);
    expect(brain.codeReviews).toHaveLength(1);
    expect(tracker.reports[0].captures).toHaveLength(1);
  });
});
