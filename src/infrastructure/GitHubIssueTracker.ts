import type { IssueTracker, ProgressView, TrackerReply, TrackerTask } from "../adapters/IssueTracker.js";
import { JobProgress } from "../domain/JobProgress.js";
import { TaskReport, type ReportInput } from "../domain/TaskReport.js";
import { STUDIO_KEY_PREFIX } from "./studio/StudioIssueTracker.js";

export const CAPTURES_BRANCH = "aitasker-captures";

const API = "https://api.github.com";
const PAGE_SIZE = 100;

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  user: { login: string };
  pull_request?: unknown;
}

interface GitHubComment {
  id: number;
  body: string | null;
  user: { login: string };
}

export class GitHubApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(`GitHub API ${status}: ${message}`);
  }
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** GitHub adapter of the IssueTracker port (REST API, token from `gh auth token`). */
export class GitHubIssueTracker implements IssueTracker {
  constructor(private readonly token: string, private readonly fetchImpl: typeof fetch = fetch) {}

  tracks(key: string): boolean {
    return !key.startsWith(STUDIO_KEY_PREFIX);
  }

  private async call<T>(method: string, path: string, body?: unknown, allow: number[] = []): Promise<{ status: number; data: T }> {
    const res = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = (text ? JSON.parse(text) : null) as T;
    if (!res.ok && !allow.includes(res.status)) {
      throw new GitHubApiError(res.status, (data as { message?: string } | null)?.message ?? res.statusText);
    }
    return { status: res.status, data };
  }

  async pendingTasks(repo: string, label: string): Promise<TrackerTask[]> {
    const query = new URLSearchParams({ state: "open", labels: label, per_page: "50", sort: "created", direction: "asc" });
    const { data } = await this.call<GitHubIssue[]>("GET", `/repos/${repo}/issues?${query}`);
    return data
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({
        key: `${repo}#${issue.number}`,
        repo,
        number: issue.number,
        title: issue.title,
        body: issue.body ?? "",
        author: issue.user.login,
        url: issue.html_url,
      }));
  }

  async comment(task: TrackerTask, markdown: string): Promise<string> {
    const { data } = await this.call<{ id: number }>("POST", `/repos/${task.repo}/issues/${task.number}/comments`, { body: markdown });
    return String(data?.id ?? "");
  }

  async updateComment(task: TrackerTask, commentId: string, markdown: string): Promise<void> {
    await this.call("PATCH", `/repos/${task.repo}/issues/comments/${commentId}`, { body: markdown });
  }

  async showProgress(task: TrackerTask, view: ProgressView, id: string | null): Promise<string> {
    const markdown = JobProgress.render(view.attempt, view.branch, view.progress, view.note);
    if (!id) return this.comment(task, markdown);
    await this.updateComment(task, id, markdown);
    return id;
  }

  async postReport(task: TrackerTask, report: ReportInput): Promise<void> {
    await this.comment(task, TaskReport.render(report));
  }

  async publishImage(task: TrackerTask, path: string, bytes: Uint8Array): Promise<string> {
    const put = () => this.call("PUT", `/repos/${task.repo}/contents/${encodePath(path)}`, {
      message: `aitasker: capture ${path}`, content: toBase64(bytes), branch: CAPTURES_BRANCH,
    }, [404]);
    if ((await put()).status === 404) {
      await this.createCapturesBranch(task.repo);
      await put().then((r) => {
        if (r.status === 404) throw new GitHubApiError(404, `cannot write ${path} on ${CAPTURES_BRANCH}`);
      });
    }
    return `https://github.com/${task.repo}/raw/${CAPTURES_BRANCH}/${encodePath(path)}`;
  }

  /** A branch with no history in common with the code: only screenshots live there. */
  private async createCapturesBranch(repo: string): Promise<void> {
    const readme = "# Captures AITasker\n\nCaptures d'écran des tâches AITasker, sans lien avec le code de l'app.\n";
    const tree = await this.call<{ sha: string }>("POST", `/repos/${repo}/git/trees`, {
      tree: [{ path: "README.md", mode: "100644", type: "blob", content: readme }],
    });
    const commit = await this.call<{ sha: string }>("POST", `/repos/${repo}/git/commits`, {
      message: "chore: branche des captures AITasker", tree: tree.data.sha, parents: [],
    });
    await this.call("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${CAPTURES_BRANCH}`, sha: commit.data.sha });
  }

  async repliesAfter(task: TrackerTask, cursor: string | null): Promise<TrackerReply[]> {
    const comments: GitHubComment[] = [];
    for (let page = 1; ; page++) {
      const { data } = await this.call<GitHubComment[]>("GET", `/repos/${task.repo}/issues/${task.number}/comments?per_page=${PAGE_SIZE}&page=${page}`);
      comments.push(...data);
      if (data.length < PAGE_SIZE) break;
    }
    const after = cursor === null ? -Infinity : Number(cursor);
    return comments
      .filter((c) => Number(c.id) > after)
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map((c) => ({ id: String(c.id), author: c.user.login, body: c.body ?? "" }));
  }

  async openMergeRequest(task: TrackerTask, branch: string, baseBranch: string): Promise<string> {
    return this.openPullRequest(task.repo, branch, baseBranch, task.title,
      `Closes #${task.number}\n\nProposé par One Week Apps Runner et validé depuis l'issue.`);
  }

  /** Opens the task branch's pull request, or returns the existing one. Also serves as Studio's code host. */
  async openPullRequest(repo: string, branch: string, baseBranch: string, title: string, body: string): Promise<string> {
    const created = await this.call<{ html_url?: string }>("POST", `/repos/${repo}/pulls`, {
      title, head: branch, base: baseBranch, body,
    }, [422]);
    if (created.status !== 422 && created.data.html_url) return created.data.html_url;
    const owner = repo.split("/")[0];
    const query = new URLSearchParams({ head: `${owner}:${branch}`, state: "open" });
    const { data } = await this.call<{ html_url: string }[]>("GET", `/repos/${repo}/pulls?${query}`);
    if (!data[0]) throw new GitHubApiError(422, `no pull request for ${branch}`);
    return data[0].html_url;
  }

  codeUrl(task: TrackerTask, branch: string, baseBranch: string): string {
    return `https://github.com/${task.repo}/compare/${encodePath(baseBranch)}...${encodePath(branch)}`;
  }

  newTaskUrl(repo: string, title: string, body: string, label: string): string {
    const shortTitle = title.length > 80 ? `${title.slice(0, 79)}…` : title;
    const query = new URLSearchParams({ title: shortTitle, body, labels: label });
    return `https://github.com/${repo}/issues/new?${query}`;
  }

  async addLabel(task: TrackerTask, label: string): Promise<void> {
    await this.call("POST", `/repos/${task.repo}/issues/${task.number}/labels`, { labels: [label] });
  }
}
