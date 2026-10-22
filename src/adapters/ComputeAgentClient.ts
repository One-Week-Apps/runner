export interface TriggerJobPayload {
  jobId: string;
  feature: {
    /** Task title, for the commit message; the description carries the instructions. */
    title?: string;
    description: string;
    repo: string;
    branch: string;
    attemptNumber: number;
    instruction: "initial_dev" | "iteration_feedback";
    lastFeedback: string | null;
    /** Managed clone: repo is "owner/name" and the compute agent clones it from cloneUrl. */
    cloneUrl?: string;
    baseBranch?: string;
    /** The brain's execution plan (the compute agent defaults to KISS: task tests, main simulator). */
    uiTests?: "task" | "all";
    devices?: "main" | "both";
    /** Claude Code session of the task's previous run: resuming it avoids rereading everything. */
    resumeSession?: string;
  };
  callbackUrl: string;
  /** Optional: where the compute agent posts each stage's progress. */
  progressUrl?: string;
  /** Optional: where to read the brain's instructions, written while the compute agent prepares the repository. */
  instructionsUrl?: string;
}

export class ComputeAgentUnreachableError extends Error {}

export interface ComputeAgentClient {
  triggerJob(payload: TriggerJobPayload): Promise<void>;
}
