import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/infrastructure/server.js";

describe("GET /health", () => {
  it("returns ok", async () => {
    const res = await request(createApp()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
