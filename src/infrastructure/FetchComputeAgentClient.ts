import type { ComputeAgentClient, TriggerJobPayload } from "../adapters/ComputeAgentClient.js";
import { ComputeAgentUnreachableError } from "../adapters/ComputeAgentClient.js";

export class FetchComputeAgentClient implements ComputeAgentClient {
  constructor(private readonly baseUrl: string) {}

  async triggerJob(payload: TriggerJobPayload): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      throw new ComputeAgentUnreachableError(`Failed to reach compute agent: ${(err as Error).message}`);
    }

    if (!res.ok) {
      throw new ComputeAgentUnreachableError(`Compute agent responded with status ${res.status}`);
    }
  }
}
