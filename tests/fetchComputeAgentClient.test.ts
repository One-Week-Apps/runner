import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { FetchComputeAgentClient } from "../src/infrastructure/FetchComputeAgentClient.js";
import { ComputeAgentUnreachableError } from "../src/adapters/ComputeAgentClient.js";

describe("FetchComputeAgentClient", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
    return new Promise((resolve) => {
      server = createServer(handler);
      server.listen(0, () => {
        const address = server!.address();
        if (address === null || typeof address === "string") {
          throw new Error("Expected server to listen on a port");
        }
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
  }

  const samplePayload = {
    jobId: "job-1",
    feature: {
      description: "Add a settings screen",
      repo: "one-week-apps/AITasker",
      branch: "main",
      attemptNumber: 0,
      instruction: "initial_dev" as const,
      lastFeedback: null,
    },
    callbackUrl: "http://localhost:3939/api/jobs/job-1/callback",
  };

  it("POSTs the payload as JSON to <baseUrl>/jobs", async () => {
    let receivedBody = "";
    let receivedPath = "";
    let receivedMethod = "";

    const baseUrl = await listen((req, res) => {
      receivedPath = req.url ?? "";
      receivedMethod = req.method ?? "";
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        receivedBody = raw;
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end("{}");
      });
    });

    const client = new FetchComputeAgentClient(baseUrl);
    await client.triggerJob(samplePayload);

    expect(receivedMethod).toBe("POST");
    expect(receivedPath).toBe("/jobs");
    expect(JSON.parse(receivedBody)).toEqual(samplePayload);
  });

  it("throws ComputeAgentUnreachableError when the response is non-2xx", async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(500);
      res.end();
    });

    const client = new FetchComputeAgentClient(baseUrl);

    await expect(client.triggerJob(samplePayload)).rejects.toThrow(ComputeAgentUnreachableError);
  });

  it("throws ComputeAgentUnreachableError when the server is unreachable", async () => {
    const baseUrl = await listen((_req, res) => res.end());
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;

    const client = new FetchComputeAgentClient(baseUrl);

    await expect(client.triggerJob(samplePayload)).rejects.toThrow(ComputeAgentUnreachableError);
  });
});
