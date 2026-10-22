import type { TrackerTask } from "../adapters/IssueTracker.js";
import type { Reviewer, ReviewerMiss } from "../adapters/ReviewerMisses.js";
import type { Lesson } from "../adapters/Brain.js";
import { recordStage, type ProgressMap, type Stage, type StageStatus } from "./JobProgress.js";

export type TrackedStatus = "queued" | "running" | "awaiting_reply" | "validated" | "abandoned";

export interface TrackedTaskProps {
  task: TrackerTask;
  status: TrackedStatus;
  attempts: number;              // attempts already started
  currentJobId: string | null;
  replyCursor: string | null;
  lastFeedback: string | null;
  queueNoticeSent: boolean;
  discoveredAt: string;
  progressCommentId?: string | null;
  progress?: ProgressMap;
  /** Fix rounds the Runner started on its own since the developer's last reply. */
  internalRounds?: number;
  /** Items handled internally during those rounds, listed (collapsed) in the report. */
  fixedInternally?: string[];
  /** All internal fixes since the start: they do not count as attempts for the developer. */
  internalTotal?: number;
  /** Reviewers who approved the last delivered report, and the knowledge version guiding them. */
  approvedBy?: Reviewer[];
  approvedWith?: string;
  /** Claude Code session of the last run: the next fix of the same task can resume it. */
  devSession?: string | null;
  /** The developer's last KO feedback, kept during internal fixes (which overwrite `lastFeedback`). */
  developerFeedback?: string | null;
  /** Lesson announced in the last report: learned if the developer approves. */
  lesson?: Lesson | null;
  /** Lesson learned on approval, and when: "OUBLIE" can remove it for one day. */
  learned?: Lesson | null;
  learnedAt?: string;
}

const FORGET_WINDOW_MS = 24 * 3600_000;

/** What the reviewers said about the delivered report: only those who approved it can have been wrong. */
export interface Delivery {
  approvedBy: Reviewer[];
  knowledge?: string;
  lesson?: Lesson | null;
}

/** A task's lifecycle: queued → running → awaiting reply → (KO: queued) / validated. */
export class TrackedTask {
  private constructor(private readonly props: TrackedTaskProps) {}

  static discover(task: TrackerTask, now: string): TrackedTask {
    return new TrackedTask({
      task, status: "queued", attempts: 0, currentJobId: null, replyCursor: null,
      lastFeedback: null, queueNoticeSent: false, discoveredAt: now,
    });
  }

  static fromProps(props: TrackedTaskProps): TrackedTask {
    return new TrackedTask(props);
  }

  toJSON(): TrackedTaskProps {
    return { ...this.props };
  }

  get key(): string { return this.props.task.key; }
  get tracker(): TrackerTask { return this.props.task; }
  /** Technical number, unique per run on the Mac (screenshot paths, commit). */
  get attempt(): number { return this.props.attempts; }
  /** The number the developer sees: one attempt = one delivery, internal fixes included. */
  get shownAttempt(): number { return this.props.attempts - (this.props.internalTotal ?? 0); }
  /** Focus (Studio) tasks have their own numbering: never the same branch as a GitHub issue or another Studio task. */
  get branch(): string {
    const { key, number } = this.props.task;
    // Each Studio account numbers its tasks from 1: the task id keeps two tasks off the same branch.
    return key.startsWith("studio:") ? `aitasker/tache-${number}-${key.slice("studio:".length, "studio:".length + 6).toLowerCase()}` : `aitasker/issue-${number}`;
  }
  /** What Claude Code receives: the title, plus the description if any. */
  get instructions(): string {
    const body = (this.props.task.body ?? "").trim();
    return body ? `${this.props.task.title}\n\n${body}` : this.props.task.title;
  }
  get replyCursor(): string | null { return this.props.replyCursor; }
  get lastFeedback(): string | null { return this.props.lastFeedback; }
  get developerFeedback(): string | null { return this.props.developerFeedback ?? null; }
  get devSession(): string | null { return this.props.devSession ?? null; }
  get discoveredAt(): string { return this.props.discoveredAt; }
  get progressCommentId(): string | null { return this.props.progressCommentId ?? null; }
  get progress(): ProgressMap { return this.props.progress ?? {}; }
  get internalRounds(): number { return this.props.internalRounds ?? 0; }
  get fixedInternally(): string[] { return this.props.fixedInternally ?? []; }

  is(status: TrackedStatus): boolean { return this.props.status === status; }
  runsJob(jobId: string): boolean { return this.props.currentJobId === jobId; }
  needsQueueNotice(): boolean { return this.is("queued") && !this.props.queueNoticeSent && this.props.attempts === 0; }

  /** The progress comment is kept during internal fixes: a single thread until the report. */
  start(jobId: string): TrackedTask {
    return this.with({ status: "running", attempts: this.props.attempts + 1, currentJobId: jobId, progress: {} });
  }

  continuesIn(session: string): TrackedTask {
    return this.with({ devSession: session });
  }

  tracksProgressIn(commentId: string): TrackedTask {
    return this.with({ progressCommentId: commentId });
  }

  record(stage: Stage, status: StageStatus, at: string, detail?: string): TrackedTask {
    return this.with({ progress: recordStage(this.progress, stage, status, at, detail) });
  }

  /** The report is published: waiting for the developer; the next attempt opens a new progress thread. */
  finish(delivery: Delivery = { approvedBy: [] }): TrackedTask {
    return this.with({
      status: "awaiting_reply", currentJobId: null, progressCommentId: null, internalRounds: 0, fixedInternally: [],
      approvedBy: delivery.approvedBy, approvedWith: delivery.knowledge, lesson: delivery.lesson ?? null,
    });
  }

  /** The announced lesson, until a KO replaces it. */
  get proposedLesson(): Lesson | null { return this.props.lesson ?? null; }
  get learnedLesson(): Lesson | null { return this.props.learned ?? null; }

  /** A learned lesson can be forgotten with one word for a day. */
  canForgetAt(now: string): boolean {
    return !!this.props.learned && !!this.props.learnedAt && Date.parse(now) - Date.parse(this.props.learnedAt) < FORGET_WINDOW_MS;
  }

  lessonForgotten(): TrackedTask {
    return this.with({ learned: null });
  }

  /** A KO on a report the reviewers had approved: they were wrong. */
  missedBy(feedback: string, at: string): ReviewerMiss | null {
    const reviewers = this.props.approvedBy ?? [];
    if (reviewers.length === 0) return null;
    return {
      at, task: this.key, title: this.tracker.title, attempt: this.shownAttempt, feedback, reviewers,
      ...(this.props.approvedWith ? { knowledge: this.props.approvedWith } : {}),
    };
  }

  canCorrectInternally(maxRounds: number): boolean {
    return this.internalRounds < maxRounds;
  }

  /** The Runner restarts an attempt on its own remarks, without bothering the developer. */
  correctInternally(feedback: string, points: string[]): TrackedTask {
    return this.with({
      status: "queued", currentJobId: null, lastFeedback: feedback,
      internalRounds: this.internalRounds + 1, internalTotal: (this.props.internalTotal ?? 0) + 1,
      fixedInternally: [...new Set([...this.fixedInternally, ...points])],
    });
  }

  retry(feedback: string): TrackedTask {
    return this.with({ status: "queued", lastFeedback: feedback, developerFeedback: feedback, approvedBy: [], approvedWith: undefined, lesson: null });
  }

  /** Issue closed (or label removed): the task leaves the queue. A job already started runs to the end. */
  abandon(): TrackedTask {
    return this.is("queued") || this.is("awaiting_reply") ? this.with({ status: "abandoned" }) : this;
  }

  validate(learned: Lesson | null = null, at?: string): TrackedTask {
    return this.with({ status: "validated", lesson: null, learned, learnedAt: learned ? at : undefined, devSession: null });
  }

  readUpTo(replyId: string): TrackedTask {
    return this.with({ replyCursor: replyId });
  }

  queueNoticed(): TrackedTask {
    return this.with({ queueNoticeSent: true });
  }

  private with(patch: Partial<TrackedTaskProps>): TrackedTask {
    return new TrackedTask({ ...this.props, ...patch });
  }
}
