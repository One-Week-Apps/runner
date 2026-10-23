import type { Express } from "express";
import { z } from "zod";
import type { IssueJobResult } from "../../usecases/IssueLoop.js";
import type { Brief } from "../Brain.js";
import { STAGES, type Stage, type StageStatus } from "../../domain/JobProgress.js";

export interface IssueJobSink {
  onJobResult(result: IssueJobResult): Promise<void>;
  onProgress(jobId: string, progress: { stage: Stage; status: StageStatus; detail?: string }): Promise<void>;
  instructionsFor?(jobId: string): Brief | "pending" | null;
}

const progressSchema = z.object({
  stage: z.enum(STAGES),
  status: z.enum(["started", "passed", "failed"]),
  detail: z.string().max(200).optional(),
});

const resultSchema = z.object({
  outcome: z.enum(["success", "failure"]),
  buildStatus: z.enum(["pending", "passed", "failed"]),
  testStatus: z.enum(["pending", "passed", "failed"]),
  nodes: z.array(z.object({
    nodeId: z.string(),
    screenshotUrl: z.string().nullable(),
    action: z.string().nullable(),
    capturedAt: z.string(),
    scenario: z.string().nullable().optional(),
    device: z.string().nullable().optional(),
    forTask: z.boolean().optional(),
    voiceOver: z.array(z.string()).nullable().optional(),
  })),
  failedTests: z.array(z.string()).optional(),
  preexistingFailures: z.array(z.string()).optional(),
  diff: z.string().nullable().optional(),
  devCostUsd: z.number().nonnegative().nullable().optional(),
  devSessionId: z.string().nullable().optional(),
  devError: z.string().max(2000).nullable().optional(),
  relatedBranches: z.array(z.object({ branch: z.string(), files: z.array(z.string()) })).optional(),
});

/** Callbacks from the compute agent for a task's job. */
export function registerIssueJobRoutes(app: Express, sink: IssueJobSink): void {
  app.post("/api/issue-jobs/:jobId/progress", async (req, res) => {
    const parsed = progressSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "validation_failed" });
      return;
    }
    await sink.onProgress(req.params.jobId, parsed.data);
    res.status(200).json({ status: "recorded" });
  });

  app.get("/api/issue-jobs/:jobId/instructions", (req, res) => {
    const brief = sink.instructionsFor?.(req.params.jobId) ?? null;
    if (brief === "pending") {
      res.status(202).json({ status: "pending" });
      return;
    }
    if (!brief) {
      res.status(404).json({ error: "unknown_job" });
      return;
    }
    res.status(200).json({ description: brief.instructions, uiTests: brief.plan.uiTests, devices: brief.plan.devices });
  });

  app.post("/api/issue-jobs/:jobId/callback", async (req, res) => {
    const parsed = resultSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "validation_failed", details: parsed.error.issues });
      return;
    }
    // The report (UX review included) takes ~40 s: acknowledge now, the compute agent only waits 10 s.
    res.status(202).json({ status: "accepted" });
    sink.onJobResult({ jobId: req.params.jobId, ...parsed.data })
      .catch((error) => console.error(`Report for job ${req.params.jobId} failed:`, error));
  });
}
