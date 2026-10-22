/** A task as the tracker describes it (a GitHub issue, a Studio task). */
export interface TrackerTask {
  key: string;          // stable id, e.g. "owner/app#7"
  repo: string;         // "owner/name"
  number: number;
  title: string;
  body: string;         // may be empty
  author: string;
  url: string;
  /** Follow-up task, born from added suggestions: jumps the queue and offers no new ones. */
  followUp?: boolean;
}

export interface TrackerReply {
  id: string;           // cursor: later replies come after this id
  author: string;
  body: string;
}

import type { ProgressMap } from "../domain/JobProgress.js";
import type { ReportInput } from "../domain/TaskReport.js";

/** An attempt's progress as the tracker shows it (an updated comment, or a field the app watches live). */
export interface ProgressView {
  attempt: number;
  branch: string;
  progress: ProgressMap;
  /** Why it is still running, e.g. an internal fix. */
  note?: string;
}

/** The task tracker port: the only piece to implement for another tracker such as GitLab. */
export interface IssueTracker {
  /** Does this task come from this tracker? A task from another source is never touched. */
  tracks(key: string): boolean;
  pendingTasks(repo: string, label: string): Promise<TrackerTask[]>;
  /** Returns the comment id, so it can be updated later. */
  comment(task: TrackerTask, markdown: string): Promise<string>;
  /** Progress: created on the first call (`id` null), updated afterwards; returns its id. */
  showProgress(task: TrackerTask, view: ProgressView, id: string | null): Promise<string>;
  /** An attempt's report: GitHub renders it as a comment, Studio keeps it structured for the app. */
  postReport(task: TrackerTask, report: ReportInput): Promise<void>;
  /** Hosts a screenshot and returns a URL displayable in the thread. */
  publishImage(task: TrackerTask, path: string, bytes: Uint8Array): Promise<string>;
  repliesAfter(task: TrackerTask, cursor: string | null): Promise<TrackerReply[]>;
  openMergeRequest(task: TrackerTask, branch: string, baseBranch: string): Promise<string>;
  addLabel(task: TrackerTask, label: string): Promise<void>;
  /** Where to read an attempt's code: the diff between the base branch and the task branch. */
  codeUrl(task: TrackerTask, branch: string, baseBranch: string): string;
  /** A link opening a prefilled new task, so an out-of-scope remark becomes a task in one click. */
  newTaskUrl(repo: string, title: string, body: string, label: string): string;
}
