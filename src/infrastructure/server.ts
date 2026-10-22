import express, { type Express } from "express";
import { registerIssueJobRoutes, type IssueJobSink } from "../adapters/http/issueJobRoutes.js";

export interface AppDeps {
  /** The task loop; absent when no tracker is configured. */
  issueJobs?: IssueJobSink;
}

/** Local HTTP API used by the compute agent to report progress and results. */
export function createApp(deps: AppDeps = {}): Express {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  if (deps.issueJobs) registerIssueJobRoutes(app, deps.issueJobs);

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}
