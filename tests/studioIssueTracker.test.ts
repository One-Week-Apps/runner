import { describe, expect, it } from "vitest";
import { StudioIssueTracker, type CodeHost } from "../src/infrastructure/studio/StudioIssueTracker.js";
import { StudioSession, type StudioConfig } from "../src/infrastructure/studio/StudioSession.js";
import { decodeFields, encodeFields } from "../src/infrastructure/studio/firestoreValues.js";
import type { TrackerTask } from "../src/adapters/IssueTracker.js";
import { TrackedTask } from "../src/domain/TrackedTask.js";
import { VALIDATED_LABEL } from "../src/usecases/IssueLoop.js";
import { parseRunnerConfig } from "../src/infrastructure/config.js";

const CONFIG: StudioConfig = {
  projectId: "demo-owa", apiKey: "key", bucket: "demo-owa.appspot.com", pairUrl: "https://pair",
};
const DOCS = "https://firestore.googleapis.com/v1/projects/demo-owa/databases/(default)/documents/users/u1";

interface Call { method: string; url: string; body: any; auth: string | null; contentType: string | null }

/** External boundary: Firebase (token, Firestore REST, Storage REST), faked. */
function fakeFirebase(routes: Record<string, (call: Call) => unknown> = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const raw = init?.body;
    const call: Call = {
      method: init?.method ?? "GET", url: String(url),
      body: typeof raw === "string" ? (raw.startsWith("{") ? JSON.parse(raw) : raw) : raw,
      auth: new Headers(init?.headers).get("authorization"),
      contentType: new Headers(init?.headers).get("content-type"),
    };
    calls.push(call);
    if (call.url.includes("securetoken")) {
      return Response.json({ id_token: "id-tok", refresh_token: "refresh", expires_in: "3600" });
    }
    const key = Object.keys(routes).find((k) => `${call.method} ${call.url}`.startsWith(k));
    return Response.json(key ? routes[key](call) : { name: `${DOCS}/x/generated-id` });
  }) as unknown as typeof fetch;
  const session = new StudioSession(CONFIG, { uid: "u1", runnerId: "mac1", refreshToken: "refresh" }, fetchImpl);
  return { calls, fetchImpl, session, firestoreCalls: () => calls.filter((c) => !c.url.includes("securetoken")) };
}

const TASK: TrackerTask = { key: "studio:t1", repo: "One-Week-Apps/EFB", number: 3, title: "Agrandir le bouton", body: "", author: "u1", url: "poissonrouge://task/t1" };
const NOW = () => "2026-10-20T10:00:00.000Z";

describe("StudioIssueTracker: the Runner picks up tasks from the Focus app", () => {
  it("lists the repository's open tasks in order, with the Mac's token", async () => {
    const fb = fakeFirebase({
      [`POST ${DOCS}:runQuery`]: () => [
        { document: { name: `${DOCS}/tasks/t1`, fields: encodeFields({ number: 3, title: "Agrandir le bouton", body: "", repo: "One-Week-Apps/EFB", open: true }) } },
        { readTime: "x" },
      ],
    });
    const tracker = new StudioIssueTracker(fb.session, undefined, fb.fetchImpl, NOW);

    expect(await tracker.pendingTasks("One-Week-Apps/EFB")).toEqual([TASK]);
    const query = fb.firestoreCalls()[0];
    expect(query.auth).toBe("Bearer id-tok");
    expect(JSON.stringify(query.body)).toContain('"fieldPath":"open"');
    expect(JSON.stringify(query.body)).toContain('"stringValue":"One-Week-Apps/EFB"');
  });

  it("writes structured progress on the task for the app to watch live", async () => {
    const fb = fakeFirebase();
    const tracker = new StudioIssueTracker(fb.session, undefined, fb.fetchImpl, NOW);

    const id = await tracker.showProgress(TASK, { attempt: 1, branch: "aitasker/tache-3", progress: { dev: { status: "started", detail: "2 fichiers" } } }, null);

    const patch = fb.firestoreCalls()[0];
    expect(id).toBe("progress");
    expect(patch.method).toBe("PATCH");
    expect(patch.url).toContain(`${DOCS}/tasks/t1?updateMask.fieldPaths=state&updateMask.fieldPaths=progress&updateMask.fieldPaths=updatedAt`);
    expect(decodeFields(patch.body.fields)).toEqual({
      state: "running", updatedAt: "2026-10-20T10:00:00.000Z",
      progress: { attempt: 1, branch: "aitasker/tache-3", stages: { dev: { status: "started", detail: "2 fichiers" } } },
    });
    expect(patch.body.fields.updatedAt).toEqual({ timestampValue: "2026-10-20T10:00:00.000Z" });
  });

  it("stores the report as is and marks the task as awaiting a reply", async () => {
    const fb = fakeFirebase();
    const tracker = new StudioIssueTracker(fb.session, undefined, fb.fetchImpl, NOW);

    await tracker.postReport(TASK, { attempt: 1, buildStatus: "passed", testStatus: "passed", captures: [], ux: null, codeUrl: "" });

    const [created, patched] = fb.firestoreCalls();
    expect(created.url).toBe(`${DOCS}/tasks/t1/reports`);
    expect(decodeFields(created.body.fields)).toMatchObject({ attempt: 1, buildStatus: "passed", ux: null, createdAt: "2026-10-20T10:00:00.000Z" });
    expect(decodeFields(patched.body.fields)).toMatchObject({ state: "awaiting_reply" });
  });

  it("writes the Runner's notes as plain text, without the GitHub marker", async () => {
    const fb = fakeFirebase({ [`POST ${DOCS}/tasks/t1/notes`]: () => ({ name: `${DOCS}/tasks/t1/notes/n9` }) });
    const tracker = new StudioIssueTracker(fb.session, undefined, fb.fetchImpl, NOW);

    expect(await tracker.comment(TASK, "<!-- aitasker -->\n⏳ En file d'attente (position 1)")).toBe("n9");
    expect(decodeFields(fb.firestoreCalls()[0].body.fields)).toMatchObject({ text: "⏳ En file d'attente (position 1)" });
  });

  it("uploads a screenshot under the account and task and returns a displayable link", async () => {
    const fb = fakeFirebase({ "POST https://firebasestorage.googleapis.com": () => ({ name: "x", downloadTokens: "dl1" }) });
    const tracker = new StudioIssueTracker(fb.session, undefined, fb.fetchImpl, NOW);

    const url = await tracker.publishImage(TASK, "tentative-1/testJouer/Accueil-iPhone_17e.png", new Uint8Array([1, 2]));

    const upload = fb.firestoreCalls()[0];
    const object = encodeURIComponent("users/u1/tasks/t1/tentative-1/testJouer/Accueil-iPhone_17e.png");
    expect(upload.url).toBe(`https://firebasestorage.googleapis.com/v0/b/demo-owa.appspot.com/o?uploadType=media&name=${object}`);
    expect(upload.auth).toBe("Firebase id-tok");
    expect(upload.contentType).toBe("image/png");
    expect(url).toBe(`https://firebasestorage.googleapis.com/v0/b/demo-owa.appspot.com/o/${object}?alt=media&token=dl1`);
  });

  it("turns the app's OK and KO into replies the domain reads, after the cursor", async () => {
    const fb = fakeFirebase({
      [`GET ${DOCS}/tasks/t1/replies`]: () => ({ documents: [
        { name: `${DOCS}/tasks/t1/replies/r1`, fields: encodeFields({ kind: "ko", feedback: "1.2 : trop petit" }) },
        { name: `${DOCS}/tasks/t1/replies/r2`, fields: encodeFields({ kind: "ok", feedback: "" }) },
      ] }),
    });
    const tracker = new StudioIssueTracker(fb.session, undefined, fb.fetchImpl, NOW);

    expect(await tracker.repliesAfter(TASK, null)).toEqual([
      { id: "r1", author: "u1", body: "KO 1.2 : trop petit" },
      { id: "r2", author: "u1", body: "OK" },
    ]);
    expect(await tracker.repliesAfter(TASK, "r1")).toEqual([{ id: "r2", author: "u1", body: "OK" }]);
    expect(fb.firestoreCalls()[0].url).toContain("orderBy=createdAt");
  });

  it("follows Firestore's page token, so a long thread never hides the latest reply", async () => {
    const reply = (id: string, kind: "ok" | "ko") => ({ name: `${DOCS}/tasks/t1/replies/${id}`, fields: encodeFields({ kind, feedback: "trop petit" }) });
    const fb = fakeFirebase({
      [`GET ${DOCS}/tasks/t1/replies`]: (call) => call.url.includes("pageToken=next")
        ? { documents: [reply("r101", "ok")] }
        : { documents: [reply("r100", "ko")], nextPageToken: "next" },
    });

    const replies = await new StudioIssueTracker(fb.session, undefined, fb.fetchImpl, NOW).repliesAfter(TASK, "r100");

    expect(replies).toEqual([{ id: "r101", author: "u1", body: "OK" }]);
  });

  it("opens the pull request at the code host and validates the task after an OK", async () => {
    const fb = fakeFirebase();
    const prs: unknown[][] = [];
    const host: CodeHost = {
      openPullRequest: async (...args) => { prs.push(args); return "https://github.com/pr/1"; },
      codeUrl: (_t, branch, base) => `https://github.com/compare/${base}...${branch}`,
    };
    const tracker = new StudioIssueTracker(fb.session, host, fb.fetchImpl, NOW);

    expect(await tracker.openMergeRequest(TASK, "aitasker/tache-3", "main")).toBe("https://github.com/pr/1");
    await tracker.addLabel(TASK, VALIDATED_LABEL);

    expect(prs[0].slice(0, 4)).toEqual(["One-Week-Apps/EFB", "aitasker/tache-3", "main", "Agrandir le bouton"]);
    expect(decodeFields(fb.firestoreCalls()[0].body.fields)).toMatchObject({ state: "validated" });
    expect(tracker.codeUrl(TASK, "aitasker/tache-3", "main")).toBe("https://github.com/compare/main...aitasker/tache-3");
  });

  it("leaves the work on its pushed branch without a code host", async () => {
    const fb = fakeFirebase();
    const tracker = new StudioIssueTracker(fb.session, undefined, fb.fetchImpl, NOW);
    expect(await tracker.openMergeRequest(TASK, "aitasker/tache-3", "main")).toBe("la branche aitasker/tache-3");
    expect(tracker.codeUrl(TASK, "b", "main")).toBe("");
  });

  it("turns an out-of-scope remark into a thought to sort in Focus", () => {
    const fb = fakeFirebase();
    expect(new StudioIssueTracker(fb.session).newTaskUrl("a/b", "Icône floue", "", "aitasker")).toBe("poissonrouge://capture?text=Ic%C3%B4ne%20floue");
  });

  it("reports that the Mac is alive", async () => {
    const fb = fakeFirebase();
    await new StudioIssueTracker(fb.session, undefined, fb.fetchImpl, NOW).heartbeat();
    const patch = fb.firestoreCalls()[0];
    expect(patch.url).toContain(`${DOCS}/runners/mac1?updateMask.fieldPaths=lastSeenAt`);
  });
});

describe("StudioIssueTracker: work batches", () => {
  it("recognizes follow-up tasks, and a KO carries the added suggestions", async () => {
    const fb = fakeFirebase({
      [`POST ${DOCS}:runQuery`]: () => [{ document: { name: `${DOCS}/tasks/t2`, fields: encodeFields({ number: 4, title: "Suites", body: "", repo: "One-Week-Apps/EFB", open: true, followUpOf: "t1" }) } }],
      [`GET ${DOCS}/tasks/t1/replies`]: () => ({ documents: [
        { name: `${DOCS}/tasks/t1/replies/r1`, fields: encodeFields({ kind: "ko", feedback: "1.1 : trop petit", extras: ["Titres de chapitre en Title 3"] }) },
        { name: `${DOCS}/tasks/t1/replies/r2`, fields: encodeFields({ kind: "ko", feedback: "", extras: ["Niveau 4 cliquable"] }) },
      ] }),
    });
    const tracker = new StudioIssueTracker(fb.session, undefined, fb.fetchImpl, NOW);

    expect((await tracker.pendingTasks("One-Week-Apps/EFB"))[0].followUp).toBe(true);
    expect((await tracker.repliesAfter(TASK, null)).map((r) => r.body)).toEqual([
      "KO 1.1 : trop petit\n- Titres de chapitre en Title 3",
      "KO - Niveau 4 cliquable",
    ]);
  });
});

describe("StudioSession", () => {
  it("refreshes the token once, reuses it, and keeps a new refresh token", async () => {
    let refreshes = 0;
    const saved: string[] = [];
    const fetchImpl = (async () => {
      refreshes++;
      return Response.json({ id_token: `id${refreshes}`, refresh_token: "nouveau", expires_in: "3600" });
    }) as unknown as typeof fetch;
    const session = new StudioSession(CONFIG, { uid: "u1", runnerId: "m", refreshToken: "ancien" }, fetchImpl, () => 0, async (s) => { saved.push(s.refreshToken); });

    expect(await session.token()).toBe("id1");
    expect(await session.token()).toBe("id1");
    expect(refreshes).toBe(1);
    expect(saved).toEqual(["nouveau"]);
  });

  it("pairs: code → custom token → session, and explains a refused code", async () => {
    const fetchImpl = (async (url: string) => {
      if (url === "https://pair") return Response.json({ uid: "u1", runnerId: "mac1", customToken: "ct" });
      return Response.json({ refreshToken: "r1", idToken: "i" });
    }) as unknown as typeof fetch;
    expect(await StudioSession.pair(CONFIG, "123456", "Mac", fetchImpl)).toEqual({ uid: "u1", runnerId: "mac1", refreshToken: "r1" });

    const refused = (async () => Response.json({ error: "invalid_code" }, { status: 404 })) as unknown as typeof fetch;
    await expect(StudioSession.pair(CONFIG, "123456", "Mac", refused)).rejects.toThrow("code inconnu ou expiré");
  });

  it("goes through the emulators in development", async () => {
    const fb = fakeFirebase();
    const emulated = new StudioSession(
      { ...CONFIG, emulators: { auth: "http://127.0.0.1:9099", firestore: "http://127.0.0.1:8080", storage: "http://127.0.0.1:9199" } },
      { uid: "u1", runnerId: "m", refreshToken: "r" }, fb.fetchImpl,
    );
    await new StudioIssueTracker(emulated, undefined, fb.fetchImpl, NOW).heartbeat();
    expect(fb.calls[0].url).toBe("http://127.0.0.1:9099/securetoken.googleapis.com/v1/token?key=key");
    expect(fb.calls[1].url.startsWith("http://127.0.0.1:8080/v1/projects/demo-owa/databases/(default)/documents/users/u1/runners/m")).toBe(true);
  });
});

describe("Studio tasks in the domain and configuration", () => {
  it("gives a Focus task its own branch, never that of a GitHub issue with the same number", () => {
    expect(TrackedTask.discover(TASK, "t").branch).toBe("aitasker/tache-3-t1");
    expect(TrackedTask.discover({ ...TASK, key: "One-Week-Apps/EFB#3" }, "t").branch).toBe("aitasker/issue-3");
  });

  it("parses the accepted repositories and Firebase endpoints", () => {
    const config = parseRunnerConfig({
      tracker: "studio", repos: { "One-Week-Apps/EFB": { baseBranch: "master" } },
      studio: { projectId: "demo-owa", apiKey: "k", bucket: "b", pairUrl: "http://127.0.0.1:5001/demo-owa/us-central1/pairRunnerWithCode" },
    });
    expect(config.tracker).toBe("studio");
    expect(config.repos["One-Week-Apps/EFB"].cloneUrl).toBe("https://github.com/One-Week-Apps/EFB.git");
    expect(() => parseRunnerConfig({ tracker: "studio", repos: {} })).toThrow();
  });
});
