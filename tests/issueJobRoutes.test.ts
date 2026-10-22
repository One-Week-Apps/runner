import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/infrastructure/server.js";
import type { IssueJobSink } from "../src/adapters/http/issueJobRoutes.js";
import type { IssueJobResult } from "../src/usecases/IssueLoop.js";

function setup(overrides: Partial<IssueJobSink> = {}) {
  const received: IssueJobResult[] = [];
  const progress: { jobId: string; stage: string; status: string; detail?: string }[] = [];
  const app = createApp({
    issueJobs: {
      onJobResult: async (r) => { received.push(r); },
      onProgress: async (jobId, p) => { progress.push({ jobId, ...p }); },
      ...overrides,
    },
  });
  return { app, received, progress };
}

const PASSED = { outcome: "success", buildStatus: "passed", testStatus: "passed", nodes: [] };

describe("POST /api/issue-jobs/:jobId/callback", () => {
  it("forwards the compute agent's result, annotated screenshots included", async () => {
    const { app, received } = setup();
    const node = { nodeId: "Home", screenshotUrl: "http://localhost:8000/screenshots/job-7/a.png", action: null, capturedAt: "t", scenario: "testPlay", device: "iPhone 17e" };

    const res = await request(app).post("/api/issue-jobs/job-7/callback").send({ ...PASSED, nodes: [node] });

    expect(res.status).toBe(202);
    expect(received).toEqual([{ jobId: "job-7", ...PASSED, nodes: [node] }]);
  });

  it("forwards the failing tests the compute agent names", async () => {
    const { app, received } = setup();
    const failure = "LoadLevelViewControllerTests/test_subtitle (iPhone 18 Pro Max) : XCTAssertTrue failed";

    await request(app).post("/api/issue-jobs/job-8/callback").send({ ...PASSED, outcome: "failure", testStatus: "failed", failedTests: [failure] });

    expect(received[0].failedTests).toEqual([failure]);
  });

  it("forwards the diff and the dev cost, and accepts them missing (null from the Mac)", async () => {
    const { app, received } = setup();

    await request(app).post("/api/issue-jobs/job-9/callback").send({ ...PASSED, diff: "+ a", devCostUsd: 1.25 });
    await request(app).post("/api/issue-jobs/job-9/callback").send({ ...PASSED, diff: null, devCostUsd: null });

    expect(received[0]).toMatchObject({ diff: "+ a", devCostUsd: 1.25 });
    expect(received[1].diff ?? null).toBeNull();
  });

  it("accepts the largest diff the compute agent sends (200,000 characters)", async () => {
    const { app, received } = setup();

    const res = await request(app).post("/api/issue-jobs/job-10/callback").send({ ...PASSED, diff: "+ é".repeat(66_667) });

    expect(res.status).toBe(202);
    expect(received[0].diff).toHaveLength(200_001);
  });

  it("acknowledges without waiting for the report (UX review ~40 s, the compute agent waits 10 s)", async () => {
    const { app } = setup({ onJobResult: () => new Promise(() => {}) });

    const res = await request(app).post("/api/issue-jobs/job-9/callback").send(PASSED).timeout(1000);

    expect(res.status).toBe(202);
  });

  it("rejects an invalid body", async () => {
    const { app, received } = setup();

    const res = await request(app).post("/api/issue-jobs/job-7/callback").send({ outcome: "maybe" });

    expect(res.status).toBe(400);
    expect(received).toHaveLength(0);
  });

  it("does not exist when no tracker is configured", async () => {
    expect((await request(createApp()).post("/api/issue-jobs/x/callback").send({})).status).toBe(404);
  });
});

describe("POST /api/issue-jobs/:jobId/progress", () => {
  it("records a known stage with its optional detail and rejects an unknown one", async () => {
    const { app, progress } = setup();

    expect((await request(app).post("/api/issue-jobs/job-7/progress").send({ stage: "build", status: "passed" })).status).toBe(200);
    expect((await request(app).post("/api/issue-jobs/job-7/progress").send({ stage: "unknown", status: "passed" })).status).toBe(400);
    await request(app).post("/api/issue-jobs/job-7/progress").send({ stage: "dev", status: "started", detail: "1 file changed: A.swift" });

    expect(progress).toEqual([
      { jobId: "job-7", stage: "build", status: "passed" },
      { jobId: "job-7", stage: "dev", status: "started", detail: "1 file changed: A.swift" },
    ]);
  });
});

describe("GET /api/issue-jobs/:jobId/instructions", () => {
  it("answers 202 while they are being written, then the instructions; 404 for an unknown job", async () => {
    const briefs = new Map<string, unknown>([["job-1", "pending"], ["job-2", { instructions: "1. Do it.", plan: { uiTests: "all", devices: "main" } }]]);
    const { app } = setup({ instructionsFor: (id) => (briefs.get(id) ?? null) as never });

    expect((await request(app).get("/api/issue-jobs/job-1/instructions")).status).toBe(202);
    const ready = await request(app).get("/api/issue-jobs/job-2/instructions");
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ description: "1. Do it.", uiTests: "all", devices: "main" });
    expect((await request(app).get("/api/issue-jobs/unknown/instructions")).status).toBe(404);
  });
});
