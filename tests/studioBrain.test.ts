import { describe, expect, it } from "vitest";
import { StudioBrain, StudioBrainError, brainUrl } from "../src/infrastructure/studio/StudioBrain.js";
import { StudioSession, type StudioConfig } from "../src/infrastructure/studio/StudioSession.js";

const CONFIG: StudioConfig = {
  projectId: "demo-owa", apiKey: "key", bucket: "demo-owa.appspot.com",
  pairUrl: "https://europe-west1-demo-owa.cloudfunctions.net/pairRunnerWithCode",
};
const BRAIN = "https://europe-west1-demo-owa.cloudfunctions.net/brain";

interface Call { url: string; body: any; auth: string | null }

/** External boundary: the Firebase token and Studio's `brain` function, faked. */
function fakeStudio(reply: (call: Call) => { status?: number; json: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("securetoken")) return Response.json({ id_token: "id-tok", refresh_token: "refresh", expires_in: "3600" });
    const call = { url: String(url), body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get("authorization") };
    calls.push(call);
    const { status = 200, json } = reply(call);
    return Response.json(json, { status });
  }) as unknown as typeof fetch;
  const session = new StudioSession(CONFIG, { uid: "u1", runnerId: "mac1", refreshToken: "refresh" }, fetchImpl);
  return { brain: new StudioBrain(session, undefined, fetchImpl), calls };
}

describe("StudioBrain: the Mac asks Studio's brain", () => {
  it("finds the `brain` function next to the pairing one, in production and on emulators", () => {
    expect(brainUrl(CONFIG.pairUrl)).toBe(BRAIN);
    expect(brainUrl("http://127.0.0.1:5001/demo-owa/europe-west1/pairRunnerWithCode")).toBe("http://127.0.0.1:5001/demo-owa/europe-west1/brain");
  });

  it("sends the brief with the Mac's token and returns Studio's answer as is", async () => {
    const brief = { instructions: "1. Fais-le.", plan: { uiTests: "task", devices: "main" }, trace: { knowledge: "a1b2c3d", model: "claude-sonnet-5-5", costUsd: 0.01 } };
    const { brain, calls } = fakeStudio(() => ({ json: { result: brief } }));

    const result = await brain.brief({ app: "EFB", title: "Agrandir le bouton", body: "", attempt: 1, feedback: null });

    expect(result).toEqual(brief);
    expect(calls[0].url).toBe(BRAIN);
    expect(calls[0].auth).toBe("Bearer id-tok");
    expect(calls[0].body).toEqual({ data: { action: "brief", request: { app: "EFB", title: "Agrandir le bouton", body: "", attempt: 1, feedback: null } } });
  });

  it("sends screenshots as base64 and skips those beyond one call's size", async () => {
    const { brain, calls } = fakeStudio(() => ({ json: { result: { verdict: "ok", remarks: [] } } }));
    const small = { scenario: "s", step: "1", device: "d", image: new Uint8Array([1, 2, 3]) };
    const huge = { scenario: "s", step: "2", device: "d", image: new Uint8Array(7_000_000) };

    await brain.review({ title: "t", body: "", captures: [small, huge] });

    expect(calls[0].body.data.request.captures).toEqual([{ scenario: "s", step: "1", device: "d", image: Buffer.from([1, 2, 3]).toString("base64") }]);
  });

  it("routes lesson proposals, learning and forgetting through Studio", async () => {
    const lesson = { text: "A : b", source: "s", scope: "EFB" };
    const { brain, calls } = fakeStudio((call) => ({ json: { result: call.body.data.action === "proposeLesson" ? lesson : { ok: true } } }));

    expect(await brain.proposeLesson({ app: "EFB", title: "t", body: "", feedback: "f", reviewers: ["ux"], source: "s" })).toEqual(lesson);
    await brain.learn(lesson);
    await brain.forget(lesson);

    expect(calls.map((c) => c.body.data.action)).toEqual(["proposeLesson", "learn", "forget"]);
  });

  it("fails on a Studio refusal or outage, so the task runs raw", async () => {
    const { brain } = fakeStudio(() => ({ status: 503, json: { error: { status: "UNAVAILABLE", message: "Cerveau indisponible" } } }));
    await expect(brain.brief({ title: "t", body: "", attempt: 1, feedback: null })).rejects.toThrow(StudioBrainError);
    await expect(brain.brief({ title: "t", body: "", attempt: 1, feedback: null })).rejects.toThrow("Cerveau indisponible");
  });
});
