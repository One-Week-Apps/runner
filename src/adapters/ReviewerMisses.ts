export type Reviewer = "ux" | "code";

/** A developer KO on a report the reviewers had approved: the raw material of lessons. */
export interface ReviewerMiss {
  at: string;
  task: string;
  title: string;
  attempt: number;
  feedback: string;
  reviewers: Reviewer[];
  /** Knowledge version that wrongly approved. */
  knowledge?: string;
}

export interface ReviewerMisses {
  record(miss: ReviewerMiss): Promise<void>;
}
