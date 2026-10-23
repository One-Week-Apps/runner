/** A screenshot as the brain sees it: the image and its place in the journey. */
export interface BrainCapture {
  scenario: string;
  step: string;
  device: string;
  image: Uint8Array;
}

/** Studio declined the call on purpose (plan, quota): the message is meant for the developer, as is. */
export class BrainRefusal extends Error {}

export interface BriefRequest {
  /** Stable task key ("owner/app#7", "studio:…"): Studio counts tasks, not calls. */
  task: string;
  /** The task's app: its own lessons are added to the shared know-how. */
  app?: string;
  title: string;
  body: string;
  /** Number of the attempt about to run (1 for the first). */
  attempt: number;
  feedback: string | null;
}

/**
 * What the Runner executes, as decided by the brain: by default (KISS) only the task's UI tests on the
 * main simulator; all tests, or a large screen as well, when the task touches shared code (navigation,
 * theme, common layout).
 */
export interface ExecutionPlan {
  uiTests: "task" | "all";
  devices: "main" | "both";
}

export const KISS_PLAN: ExecutionPlan = { uiTests: "task", devices: "main" };

/** Where a brain answer comes from: the knowledge version and the model that produced it. */
export interface BrainTrace {
  knowledge: string;
  model: string;
  /** Estimated cost of the call (list prices), when known. */
  costUsd?: number;
}

/** At most three "done" criteria per task, written "Screen: expected". */
export const MAX_CRITERIA = 3;

export interface Brief {
  instructions: string;
  plan: ExecutionPlan;
  /** What must be true on screen for the task to be done; the reviewers check them. */
  criteria?: string[];
  trace?: BrainTrace;
  /** Fallback instructions: the raw task, because the brain did not answer. */
  fallback?: true;
  /** Reviews the developer's plan includes; the Runner skips the others instead of sending screenshots for nothing. */
  reviews?: { ux: boolean };
  /** What the task will touch, predicted before it runs: the Runner groups or holds overlapping tasks. */
  footprint?: Footprint;
  /** The task is too ambiguous to run: asked to the developer before any attempt. */
  question?: string;
}

/** Task size, from a label or a color (s) to a new screen (l). */
export type TaskSize = "s" | "m" | "l";

export interface Footprint {
  /** Target screens, named as in the criteria ("Niveaux"). */
  screens: string[];
  /** Files it will likely change (names only), when the task says enough to guess them. */
  files?: string[];
  /** Touches code shared by several screens (navigation, global theme, startup, data). */
  shared: boolean;
  size: TaskSize;
}

export interface ReviewRequest {
  task: string;
  app?: string;
  title: string;
  body: string;
  captures: BrainCapture[];
  /** Follow-up task (born from suggestions): no new suggestions, so feedback does not snowball. */
  followUp?: boolean;
  /** "Done" criteria written with the instructions, to check one by one. */
  criteria?: string[];
  /** The developer's last KO feedback: what they ask for is part of the task. */
  feedback?: string;
}

/** `met` absent: the criterion cannot be checked from where the reviewer looks. */
export interface CriterionCheck {
  label: string;
  met?: boolean;
  /** Who checked it: the UX review on screenshots, or the code review in the diff. */
  by?: "ux" | "code";
}

/**
 * A remark in two parts: what the developer reads, in minimal wording ("Home: title too small"),
 * and the fix the AI decided on for Claude Code ("title as Large Title, 34 pt bold").
 */
export interface Remark {
  label: string;
  fix: string;
}

/** At most two remarks and suggestions per report, the most useful ones: small, fast iterations. */
export const MAX_SHOWN_REMARKS = 2;

export interface UxReview {
  verdict: "ok" | "to_fix";
  /** To fix within the task, shown to the developer. */
  remarks: Remark[];
  /** Internal plumbing (tests, screenshots, harness): fixed by the Runner, listed collapsed by label only. */
  internal?: Remark[];
  /** Outside the task's scope: offered to the developer, who can add them in one tap. */
  outOfScope?: Remark[];
  criteria?: CriterionCheck[];
  trace?: BrainTrace;
}

export interface CodeReviewRequest {
  task: string;
  app?: string;
  title: string;
  body: string;
  /** The task's diff against its base branch, as committed by the Mac. */
  diff: string;
  /** The developer's last KO feedback: what they ask for is part of the task. */
  feedback?: string;
  /** "Done" criteria: the code review checks those visible in the code. */
  criteria?: string[];
}

/** Review of the diff by a reviewer who sees neither the screenshots nor the coding agent's reasoning. */
export interface CodeReview {
  verdict: "ok" | "to_fix";
  remarks: Remark[];
  criteria?: CriterionCheck[];
  trace?: BrainTrace;
}

/** What a reviewer let through, according to the developer's KO. */
export interface LessonRequest {
  task: string;
  app: string;
  title: string;
  body: string;
  feedback: string;
  reviewers: ("ux" | "code")[];
  /** Where the lesson comes from ("task · date"), stored with it. */
  source: string;
}

/** A one-line rule, learned when the developer approves the fix that gave rise to it. */
export interface Lesson {
  text: string;
  source: string;
  /** The app it applies to, or "all" once confirmed on another app. */
  scope: string;
}

/**
 * The One Week Apps know-how (UX guidelines, harness, observability) stays on the server.
 * Only its conclusions for a given task come out, never the know-how itself.
 */
export interface Brain {
  brief(request: BriefRequest): Promise<Brief>;
  review(request: ReviewRequest): Promise<UxReview>;
  reviewCode(request: CodeReviewRequest): Promise<CodeReview>;
  /** null when there is nothing new to learn (already known, or too specific). */
  proposeLesson(request: LessonRequest): Promise<Lesson | null>;
  /** The developer approved the fix: the lesson is learned. */
  learn(lesson: Lesson): Promise<void>;
  /** "OUBLIE": the lesson is forgotten. */
  forget(lesson: Lesson): Promise<void>;
}
