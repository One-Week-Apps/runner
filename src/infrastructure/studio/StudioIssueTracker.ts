import type { IssueTracker, MergeOutcome, ProgressView, TrackerReply, TrackerTask } from "../../adapters/IssueTracker.js";
import type { ReportInput } from "../../domain/TaskReport.js";
import { RUNNER_MARKER } from "../../domain/Reply.js";
import { VALIDATED_LABEL } from "../../usecases/IssueLoop.js";
import { decodeFields, encodeFields, FirestoreTimestamp, type Fields } from "./firestoreValues.js";
import { endpoints, type StudioSession } from "./StudioSession.js";

/** Where the code lives: GitHub merges (or opens the pull request) after an OK and shows the diff. Without it, the work stays on the pushed branch. */
export interface CodeHost {
  openPullRequest(repo: string, branch: string, baseBranch: string, title: string, body: string): Promise<string>;
  mergePullRequest(repo: string, branch: string, baseBranch: string, title: string, body: string, commit?: string): Promise<MergeOutcome>;
  pullRequestMerged(repo: string, branch: string): Promise<boolean>;
  codeUrl(task: TrackerTask, branch: string, baseBranch: string): string;
}

export class StudioApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(`Studio ${status}: ${message}`);
  }
}

export const STUDIO_KEY_PREFIX = "studio:";
/** Deep link into the Focus app (its historical `poissonrouge` scheme). */
export const FOCUS_SCHEME = "poissonrouge://";

interface FirestoreDocument { name: string; fields?: Fields }

const CONTENT_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", mp4: "video/mp4" };

/**
 * Studio (Firebase) adapter of the IssueTracker port: tasks come from the Focus app, and progress and
 * reports go back to it as structured data. The Mac only makes outgoing requests, with its own token.
 */
export class StudioIssueTracker implements IssueTracker {
  constructor(
    private readonly session: StudioSession,
    private readonly codeHost?: CodeHost,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  tracks(key: string): boolean {
    return key.startsWith(STUDIO_KEY_PREFIX);
  }

  private get documents(): string {
    return `${endpoints(this.session.config).documents}/users/${this.session.uid}`;
  }

  private taskId(task: TrackerTask): string {
    return task.key.slice(STUDIO_KEY_PREFIX.length);
  }

  private async call<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${await this.session.token()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new StudioApiError(res.status, text.slice(0, 300));
    return (text ? JSON.parse(text) : null) as T;
  }

  private async patch(path: string, fields: Record<string, unknown>): Promise<void> {
    const mask = Object.keys(fields).map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join("&");
    await this.call("PATCH", `${this.documents}/${path}?${mask}&currentDocument.exists=true`, { fields: encodeFields(fields) });
  }

  private async add(collectionPath: string, fields: Record<string, unknown>): Promise<string> {
    const created = await this.call<FirestoreDocument>("POST", `${this.documents}/${collectionPath}`, { fields: encodeFields(fields) });
    return created.name.split("/").pop()!;
  }

  private stamp(): FirestoreTimestamp {
    return new FirestoreTimestamp(this.now());
  }

  /** Tells Studio this Mac is alive, so Focus can show it as connected or asleep. */
  async heartbeat(): Promise<void> {
    await this.patch(`runners/${this.session.runnerId}`, { lastSeenAt: this.stamp() });
  }

  async pendingTasks(repo: string): Promise<TrackerTask[]> {
    const where = (field: string, value: unknown) => ({ fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: encodeFields({ v: value }).v } });
    const rows = await this.call<{ document?: FirestoreDocument }[]>("POST", `${this.documents}:runQuery`, {
      structuredQuery: {
        from: [{ collectionId: "tasks" }],
        where: { compositeFilter: { op: "AND", filters: [where("open", true), where("repo", repo)] } },
        orderBy: [{ field: { fieldPath: "number" }, direction: "ASCENDING" }],
      },
    });
    return rows.filter((row) => row.document).map(({ document }) => {
      const id = document!.name.split("/").pop()!;
      const data = decodeFields(document!.fields ?? {}) as { number: number; title: string; body?: string; followUpOf?: string; rank?: number };
      return {
        key: `${STUDIO_KEY_PREFIX}${id}`, repo, number: data.number, title: data.title, body: data.body ?? "",
        author: this.session.uid, url: `${FOCUS_SCHEME}task/${id}`, ...(data.followUpOf ? { followUp: true } : {}),
        ...(typeof data.rank === "number" ? { rank: data.rank } : {}),
      };
    });
  }

  /** The Runner's notes (queued, validated…): plain text for the app, without the GitHub comment marker. */
  async comment(task: TrackerTask, markdown: string): Promise<string> {
    const text = markdown.replace(RUNNER_MARKER, "").trim();
    return this.add(`tasks/${this.taskId(task)}/notes`, { text, createdAt: this.stamp() });
  }

  async showProgress(task: TrackerTask, view: ProgressView, _id: string | null): Promise<string> {
    await this.patch(`tasks/${this.taskId(task)}`, {
      state: "running",
      progress: { attempt: view.attempt, branch: view.branch, stages: view.progress, note: view.note },
      updatedAt: this.stamp(),
    });
    return "progress";
  }

  async postReport(task: TrackerTask, report: ReportInput): Promise<void> {
    await this.add(`tasks/${this.taskId(task)}/reports`, { ...report, createdAt: this.stamp() });
    await this.patch(`tasks/${this.taskId(task)}`, { state: "awaiting_reply", updatedAt: this.stamp() });
  }

  async publishImage(task: TrackerTask, path: string, bytes: Uint8Array): Promise<string> {
    const base = endpoints(this.session.config).storage;
    const objectPath = `users/${this.session.uid}/tasks/${this.taskId(task)}/${path}`;
    const res = await this.fetchImpl(`${base}?uploadType=media&name=${encodeURIComponent(objectPath)}`, {
      method: "POST",
      headers: {
        Authorization: `Firebase ${await this.session.token()}`,
        "Content-Type": CONTENT_TYPES[path.split(".").pop()!.toLowerCase()] ?? "application/octet-stream",
      },
      body: Buffer.from(bytes),
    });
    const text = await res.text();
    if (!res.ok) throw new StudioApiError(res.status, text.slice(0, 300));
    const { downloadTokens } = JSON.parse(text) as { downloadTokens?: string };
    return `${base}/${encodeURIComponent(objectPath)}?alt=media${downloadTokens ? `&token=${downloadTokens.split(",")[0]}` : ""}`;
  }

  /** OK or KO sent from Focus, in the form the domain reads ("OK", "KO 1.2: …"). */
  async repliesAfter(task: TrackerTask, cursor: string | null): Promise<TrackerReply[]> {
    const documents: FirestoreDocument[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.call<{ documents?: FirestoreDocument[]; nextPageToken?: string }>(
        "GET", `${this.documents}/tasks/${this.taskId(task)}/replies?orderBy=createdAt&pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
      );
      documents.push(...(page?.documents ?? []));
      pageToken = page?.nextPageToken;
    } while (pageToken);
    const replies = documents.map((document) => {
      const data = decodeFields(document.fields ?? {}) as { kind: "ok" | "ko" | "answer"; feedback?: string; extras?: string[] };
      // A KO also carries the suggestions added with it: they all go into the same attempt.
      const lines = [(data.feedback ?? "").trim(), ...(data.extras ?? []).map((extra) => `- ${extra.trim()}`)].filter(Boolean);
      return {
        id: document.name.split("/").pop()!,
        author: this.session.uid,
        // `answer`: the developer's answer to Studio's question, read as plain text.
        body: data.kind === "ok" ? "OK" : data.kind === "answer" ? (data.feedback ?? "").trim() : `KO ${lines.join("\n")}`,
      };
    });
    const start = cursor === null ? 0 : replies.findIndex((r) => r.id === cursor) + 1;
    return replies.slice(start);
  }

  async openMergeRequest(task: TrackerTask, branch: string, baseBranch: string): Promise<string> {
    if (!this.codeHost) return `la branche ${branch}`;
    return this.codeHost.openPullRequest(task.repo, branch, baseBranch, task.title, this.pullRequestBody(task));
  }

  async merge(task: TrackerTask, branch: string, baseBranch: string, commit?: string): Promise<MergeOutcome> {
    if (!this.codeHost) return { status: "refused", url: `la branche ${branch}`, reason: "pas d'accès GitHub sur ce Mac" };
    return this.codeHost.mergePullRequest(task.repo, branch, baseBranch, task.title, this.pullRequestBody(task), commit);
  }

  /** Without a code host the Runner cannot see the merge: the task does not hold anything. */
  async isMerged(task: TrackerTask, branch: string): Promise<boolean> {
    return this.codeHost ? this.codeHost.pullRequestMerged(task.repo, branch) : true;
  }

  /** Focus shows it on the task, live; null once it starts. */
  async showWaiting(task: TrackerTask, reason: string | null): Promise<void> {
    await this.patch(`tasks/${this.taskId(task)}`, { waiting: reason, updatedAt: this.stamp() });
  }

  private pullRequestBody(task: TrackerTask): string {
    return `${task.body ? `${task.body}\n\n` : ""}Tâche n°${task.number} de One Week Apps Focus, développée par le Runner et validée depuis l'app.`;
  }

  async addLabel(task: TrackerTask, label: string): Promise<void> {
    if (label === VALIDATED_LABEL) await this.patch(`tasks/${this.taskId(task)}`, { state: "validated", updatedAt: this.stamp() });
  }

  codeUrl(task: TrackerTask, branch: string, baseBranch: string): string {
    return this.codeHost?.codeUrl(task, branch, baseBranch) ?? "";
  }

  /** An out-of-scope remark becomes a thought to sort in Focus, in one tap. */
  newTaskUrl(_repo: string, title: string, _body: string, _label: string): string {
    return `${FOCUS_SCHEME}capture?text=${encodeURIComponent(title)}`;
  }
}
