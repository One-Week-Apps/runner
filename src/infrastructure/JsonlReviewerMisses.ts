import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ReviewerMiss, ReviewerMisses } from "../adapters/ReviewerMisses.js";

/** One miss per line, in order: easy to count, to read back and to turn into a lesson. */
export class JsonlReviewerMisses implements ReviewerMisses {
  constructor(private readonly path: string) {}

  async record(miss: ReviewerMiss): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(miss)}\n`, "utf-8");
  }
}
