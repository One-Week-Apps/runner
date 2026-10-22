import { describe, expect, it } from "vitest";
import { GitHubIssueTracker, CAPTURES_BRANCH } from "../src/infrastructure/GitHubIssueTracker.js";
import type { TrackerTask } from "../src/adapters/IssueTracker.js";

interface Call { method: string; url: string; body: any; auth: string | null }

function fakeGitHub(routes: Record<string, (call: Call) => { status: number; body?: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: new Headers(init?.headers).get("authorization"),
    };
    calls.push(call);
    const path = call.url.replace("https://api.github.com", "").split("?")[0];
    const handler = routes[`${call.method} ${path}`];
    const res = handler ? handler(call) : { status: 404, body: { message: "Not Found" } };
    return new Response(res.body === undefined ? null : JSON.stringify(res.body), { status: res.status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const TASK: TrackerTask = { key: "One-Week-Apps/EFB#7", repo: "One-Week-Apps/EFB", number: 7, title: "Agrandir le bouton", body: "Le bouton Jouer est trop petit.", author: "octocat", url: "https://github.com/One-Week-Apps/EFB/issues/7" };

describe("GitHubIssueTracker", () => {
  it("lists the label's open issues, without pull requests, using the token", async () => {
    const gh = fakeGitHub({
      "GET /repos/One-Week-Apps/EFB/issues": () => ({ status: 200, body: [
        { number: 7, title: "Agrandir le bouton", body: "Le bouton Jouer est trop petit.", user: { login: "octocat" }, html_url: "https://github.com/One-Week-Apps/EFB/issues/7" },
        { number: 8, title: "PR", user: { login: "x" }, html_url: "u", pull_request: {} },
      ] }),
    });
    const tracker = new GitHubIssueTracker("tok", gh.fetchImpl);

    expect(await tracker.pendingTasks("One-Week-Apps/EFB", "aitasker")).toEqual([TASK]);
    expect(gh.calls[0].url).toContain("state=open");
    expect(gh.calls[0].url).toContain("labels=aitasker");
    expect(gh.calls[0].auth).toBe("Bearer tok");
  });

  it("comments on the issue and returns the comment id", async () => {
    const gh = fakeGitHub({ "POST /repos/One-Week-Apps/EFB/issues/7/comments": () => ({ status: 201, body: { id: 4242 } }) });

    const id = await new GitHubIssueTracker("tok", gh.fetchImpl).comment(TASK, "Bonjour");

    expect(id).toBe("4242");
    expect(gh.calls[0].body).toEqual({ body: "Bonjour" });
  });

  it("updates an existing comment", async () => {
    const gh = fakeGitHub({ "PATCH /repos/One-Week-Apps/EFB/issues/comments/4242": () => ({ status: 200, body: {} }) });

    await new GitHubIssueTracker("tok", gh.fetchImpl).updateComment(TASK, "4242", "Mis à jour");

    expect(gh.calls[0].body).toEqual({ body: "Mis à jour" });
  });

  it("progress: a comment created the first time, then updated in place", async () => {
    const gh = fakeGitHub({
      "POST /repos/One-Week-Apps/EFB/issues/7/comments": () => ({ status: 201, body: { id: 4242 } }),
      "PATCH /repos/One-Week-Apps/EFB/issues/comments/4242": () => ({ status: 200, body: {} }),
    });
    const tracker = new GitHubIssueTracker("tok", gh.fetchImpl);

    const id = await tracker.showProgress(TASK, { attempt: 1, branch: "aitasker/issue-7", progress: {} }, null);
    await tracker.showProgress(TASK, { attempt: 1, branch: "aitasker/issue-7", progress: { dev: { status: "passed" } } }, id);

    expect(id).toBe("4242");
    expect(gh.calls[0].body.body).toContain("Tentative 1 lancée");
    expect(gh.calls[1].method).toBe("PATCH");
    expect(gh.calls[1].body.body).toContain("✅ Claude Code développe");
  });

  it("renders the report as a Markdown comment", async () => {
    const gh = fakeGitHub({ "POST /repos/One-Week-Apps/EFB/issues/7/comments": () => ({ status: 201, body: { id: 1 } }) });

    await new GitHubIssueTracker("tok", gh.fetchImpl).postReport(TASK, { attempt: 2, buildStatus: "passed", testStatus: "passed", captures: [] });

    expect(gh.calls[0].body.body).toContain("**Tentative 2** · Build ✅ · Tests ✅");
  });

  it("publishes a screenshot on the screenshots branch and returns a displayable /raw/ link", async () => {
    const gh = fakeGitHub({
      "PUT /repos/One-Week-Apps/EFB/contents/issue-7/tentative-1/testJouer/Accueil-iPhone_17e.png": () => ({ status: 201, body: {} }),
    });

    const url = await new GitHubIssueTracker("tok", gh.fetchImpl).publishImage(TASK, "issue-7/tentative-1/testJouer/Accueil-iPhone_17e.png", new Uint8Array([1, 2, 3]));

    expect(url).toBe(`https://github.com/One-Week-Apps/EFB/raw/${CAPTURES_BRANCH}/issue-7/tentative-1/testJouer/Accueil-iPhone_17e.png`);
    expect(gh.calls[0].body).toMatchObject({ branch: CAPTURES_BRANCH, content: "AQID" });
  });

  it("creates the screenshots branch (without history) when it does not exist yet", async () => {
    let created = false;
    const gh = fakeGitHub({
      "PUT /repos/One-Week-Apps/EFB/contents/a.png": () => (created ? { status: 201, body: {} } : { status: 404, body: { message: "Branch aitasker-captures not found" } }),
      "POST /repos/One-Week-Apps/EFB/git/trees": () => ({ status: 201, body: { sha: "tree1" } }),
      "POST /repos/One-Week-Apps/EFB/git/commits": () => ({ status: 201, body: { sha: "commit1" } }),
      "POST /repos/One-Week-Apps/EFB/git/refs": () => { created = true; return { status: 201, body: {} }; },
    });

    await new GitHubIssueTracker("tok", gh.fetchImpl).publishImage(TASK, "a.png", new Uint8Array([1]));

    const commit = gh.calls.find((c) => c.url.endsWith("/git/commits"))!;
    expect(commit.body.parents).toEqual([]);
    expect(gh.calls.find((c) => c.url.endsWith("/git/refs"))!.body).toEqual({ ref: `refs/heads/${CAPTURES_BRANCH}`, sha: "commit1" });
    expect(gh.calls.filter((c) => c.method === "PUT")).toHaveLength(2);
  });

  it("reads replies after the cursor, in order", async () => {
    const gh = fakeGitHub({
      "GET /repos/One-Week-Apps/EFB/issues/7/comments": () => ({ status: 200, body: [
        { id: 10, user: { login: "octocat" }, body: "ancien" },
        { id: 12, user: { login: "octocat" }, body: "OK" },
      ] }),
    });
    const tracker = new GitHubIssueTracker("tok", gh.fetchImpl);

    expect(await tracker.repliesAfter(TASK, "10")).toEqual([{ id: "12", author: "octocat", body: "OK" }]);
    expect((await tracker.repliesAfter(TASK, null)).map((r) => r.id)).toEqual(["10", "12"]);
  });

  it("reads past the first page of comments, so a long thread never hides the latest reply", async () => {
    const page = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ id: from + i, user: { login: "octocat" }, body: "progress" }));
    const gh = fakeGitHub({
      "GET /repos/One-Week-Apps/EFB/issues/7/comments": (call) => ({
        status: 200,
        body: new URL(call.url).searchParams.get("page") === "1" ? page(1, 100) : [{ id: 101, user: { login: "octocat" }, body: "OK" }],
      }),
    });

    const replies = await new GitHubIssueTracker("tok", gh.fetchImpl).repliesAfter(TASK, "100");

    expect(replies).toEqual([{ id: "101", author: "octocat", body: "OK" }]);
  });

  it("opens the pull request closing the issue, or finds the existing one", async () => {
    const created = fakeGitHub({ "POST /repos/One-Week-Apps/EFB/pulls": () => ({ status: 201, body: { html_url: "https://github.com/One-Week-Apps/EFB/pull/9" } }) });
    expect(await new GitHubIssueTracker("tok", created.fetchImpl).openMergeRequest(TASK, "aitasker/issue-7", "master"))
      .toBe("https://github.com/One-Week-Apps/EFB/pull/9");
    expect(created.calls[0].body).toMatchObject({ head: "aitasker/issue-7", base: "master", title: "Agrandir le bouton" });
    expect(created.calls[0].body.body).toContain("Closes #7");

    const existing = fakeGitHub({
      "POST /repos/One-Week-Apps/EFB/pulls": () => ({ status: 422, body: { message: "A pull request already exists" } }),
      "GET /repos/One-Week-Apps/EFB/pulls": () => ({ status: 200, body: [{ html_url: "https://github.com/One-Week-Apps/EFB/pull/5" }] }),
    });
    expect(await new GitHubIssueTracker("tok", existing.fetchImpl).openMergeRequest(TASK, "aitasker/issue-7", "master"))
      .toBe("https://github.com/One-Week-Apps/EFB/pull/5");
    expect(existing.calls[1].url).toContain("head=One-Week-Apps%3Aaitasker%2Fissue-7");
  });

  it("adds a label", async () => {
    const gh = fakeGitHub({ "POST /repos/One-Week-Apps/EFB/issues/7/labels": () => ({ status: 200, body: [] }) });
    await new GitHubIssueTracker("tok", gh.fetchImpl).addLabel(TASK, "aitasker:validé");
    expect(gh.calls[0].body).toEqual({ labels: ["aitasker:validé"] });
  });

  it("links a task's code to the GitHub base...branch comparison", () => {
    const tracker = new GitHubIssueTracker("tok", fakeGitHub({}).fetchImpl);
    expect(tracker.codeUrl(TASK, "aitasker/issue-7", "chore/xcode27")).toBe("https://github.com/One-Week-Apps/EFB/compare/chore/xcode27...aitasker/issue-7");
  });

  it("turns an out-of-scope remark into a prefilled new-issue link with the Runner's label", () => {
    const url = new URL(new GitHubIssueTracker("tok", fakeGitHub({}).fetchImpl).newTaskUrl("One-Week-Apps/EFB", "Titres de chapitres en taille fixe", "Repéré sur #7.", "aitasker"));
    expect(url.origin + url.pathname).toBe("https://github.com/One-Week-Apps/EFB/issues/new");
    expect(url.searchParams.get("title")).toBe("Titres de chapitres en taille fixe");
    expect(url.searchParams.get("body")).toBe("Repéré sur #7.");
    expect(url.searchParams.get("labels")).toBe("aitasker");
  });

  it("surfaces API errors with their status", async () => {
    const gh = fakeGitHub({});
    await expect(new GitHubIssueTracker("tok", gh.fetchImpl).comment(TASK, "x")).rejects.toThrow("404");
  });
});
