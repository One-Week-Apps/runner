import type { TrackerTask } from "../adapters/IssueTracker.js";
import type { Reviewer, ReviewerMiss } from "../adapters/ReviewerMisses.js";
import type { Footprint, Lesson } from "../adapters/Brain.js";
import { recordStage, type ProgressMap, type Stage, type StageStatus } from "./JobProgress.js";

/** `grouped`: rides along another task's attempt (same screen), which carries its report and the reply. */
export type TrackedStatus = "queued" | "running" | "awaiting_reply" | "validated" | "abandoned" | "grouped";

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
  /** What the task will touch, predicted by Studio while it waits; undefined until prepared. */
  footprint?: Footprint | null;
  /** Studio's question before the first attempt, until the developer answers it. */
  question?: string | null;
  /** The developer's answers to Studio's questions, part of the task from then on. */
  clarification?: string;
  /** Files the attempts really changed, from the diff: more reliable than the prediction. */
  changedFiles?: string[];
  /** Tasks grouped into this one's attempt: their consignes go with it. */
  members?: GroupMember[];
  /** The task whose attempt carries this one. */
  groupedInto?: string;
  /** Validated, but its pull request waits for the developer's merge (pull request mode). */
  awaitingMerge?: boolean;
  /** The waiting reason last shown, so it is told once. */
  waitingShown?: string | null;
  /** Subject of the merge commit, written by the code review for the last delivery. */
  commit?: string;
}

export interface GroupMember {
  key: string;
  title: string;
  body: string;
}

/** What a task holds while it is delivered and not merged: two tasks touching the same thing wait for each other. */
export interface Touch {
  screens: string[];
  files: string[];
  shared: boolean;
}

const fileName = (path: string) => path.split("/").pop()!;

const FORGET_WINDOW_MS = 24 * 3600_000;

/** What the reviewers said about the delivered report: only those who approved it can have been wrong. */
export interface Delivery {
  approvedBy: Reviewer[];
  knowledge?: string;
  lesson?: Lesson | null;
  commit?: string;
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
    const body = this.body.trim();
    return body ? `${this.title}\n\n${body}` : this.title;
  }
  /** The task as Studio and the reviewers read it: grouped consignes and the developer's answers included. */
  get title(): string {
    const others = this.members.length;
    return others ? `${this.props.task.title} (+ ${others} consigne${others > 1 ? "s" : ""} regroupée${others > 1 ? "s" : ""})` : this.props.task.title;
  }
  get body(): string {
    return [
      (this.props.task.body ?? "").trim(),
      this.props.clarification ? `Précision du développeur : ${this.props.clarification}` : "",
      ...this.members.map((m, i) => `Consigne regroupée ${i + 2} : ${m.title}${m.body.trim() ? `\n${m.body.trim()}` : ""}`),
    ].filter(Boolean).join("\n\n");
  }
  get members(): GroupMember[] { return this.props.members ?? []; }
  get groupedInto(): string | null { return this.props.groupedInto ?? null; }
  get footprint(): Footprint | null { return this.props.footprint ?? null; }
  get prepared(): boolean { return this.props.footprint !== undefined; }
  get pendingQuestion(): string | null { return this.props.question ?? null; }
  get awaitingMerge(): boolean { return !!this.props.awaitingMerge; }
  /** What the merge commit says; without it, the task's title. */
  get commitSubject(): string | undefined { return this.props.commit; }
  get waitingShown(): string | null { return this.props.waitingShown ?? null; }
  /** A KO from the developer: they wait for this attempt with the context in mind. */
  get isDeveloperRetry(): boolean { return this.props.attempts > 0 && this.internalRounds === 0; }
  /** What it touches, known from the diff once it ran, predicted before; null when nothing is known. */
  get touch(): Touch | null {
    const footprint = this.props.footprint;
    const changed = this.props.changedFiles ?? [];
    if (!footprint && changed.length === 0) return null;
    return {
      screens: footprint?.screens ?? [],
      files: [...new Set([...changed, ...(footprint?.files ?? [])].map(fileName))],
      shared: footprint?.shared ?? false,
    };
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
      approvedBy: delivery.approvedBy, approvedWith: delivery.knowledge, lesson: delivery.lesson ?? null, commit: delivery.commit,
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
    return this.is("queued") || this.is("awaiting_reply") || this.is("grouped") ? this.with({ status: "abandoned" }) : this;
  }

  /** `awaitingMerge`: pull request mode, the task keeps its screens and files until the developer merges. */
  validate(learned: Lesson | null = null, at?: string, awaitingMerge = false): TrackedTask {
    return this.with({ status: "validated", lesson: null, learned, learnedAt: learned ? at : undefined, devSession: null, awaitingMerge });
  }

  merged(): TrackedTask {
    return this.with({ awaitingMerge: false });
  }

  /** Studio read the task while it waited: what it touches, and its question if it is ambiguous. */
  preparedWith(footprint: Footprint | null, question: string | null): TrackedTask {
    return this.with({ footprint, question });
  }

  /** The developer answered Studio's question: it is part of the task, and Studio reads it again. */
  answered(text: string): TrackedTask {
    const clarification = this.props.clarification ? `${this.props.clarification}\n${text}` : text;
    return this.with({ clarification, question: null, footprint: undefined });
  }

  /** The files the attempts really changed. */
  changed(files: string[]): TrackedTask {
    return files.length ? this.with({ changedFiles: [...new Set([...(this.props.changedFiles ?? []), ...files])] }) : this;
  }

  /** This task's attempt also carries the members' consignes. */
  carrying(members: TrackedTask[]): TrackedTask {
    return members.length
      ? this.with({ members: [...this.members, ...members.map((m) => ({ key: m.key, title: m.tracker.title, body: m.tracker.body }))] })
      : this;
  }

  groupInto(leader: TrackedTask): TrackedTask {
    return this.with({ status: "grouped", groupedInto: leader.key });
  }

  /** Its group was dropped (the carrying task closed): back in the queue on its own. */
  ungroup(): TrackedTask {
    return this.with({ status: "queued", groupedInto: undefined });
  }

  /** The developer reordered the queue: the task keeps its place from the tracker. */
  reranked(rank: number | undefined): TrackedTask {
    return rank === this.props.task.rank ? this : this.with({ task: { ...this.props.task, rank } });
  }

  waitingFor(reason: string | null): TrackedTask {
    return this.with({ waitingShown: reason });
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
