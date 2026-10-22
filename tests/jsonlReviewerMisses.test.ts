import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { JsonlReviewerMisses } from "../src/infrastructure/JsonlReviewerMisses.js";

describe("JsonlReviewerMisses: one miss per line", () => {
  it("appends each miss, creating the folder if needed", async () => {
    const path = join(tmpdir(), `owa-${randomUUID()}`, "reviewer-misses.jsonl");
    const misses = new JsonlReviewerMisses(path);
    const miss = { at: "2026-10-21T18:00:00Z", task: "o/r#7", title: "Titre", attempt: 1, feedback: "coupé", reviewers: ["ux" as const] };

    await misses.record(miss);
    await misses.record({ ...miss, attempt: 2 });

    const lines = readFileSync(path, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => line.attempt)).toEqual([1, 2]);
  });
});
