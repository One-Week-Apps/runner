import { BrainRefusal, type Brain, type Brief, BriefRequest, CodeReview, CodeReviewRequest, Lesson, LessonRequest, ReviewRequest, UxReview } from "../../adapters/Brain.js";
import type { StudioSession } from "./StudioSession.js";

/** A Studio function call is capped at 10 MB: screenshots beyond this budget stay in the report but are not reviewed. */
const MAX_CAPTURE_BYTES = 6_500_000;

export class StudioBrainError extends Error {}

/** Callable error statuses Studio uses to decline on purpose (no plan, quota, review not included). */
const REFUSALS: ReadonlySet<string> = new Set(["PERMISSION_DENIED", "RESOURCE_EXHAUSTED", "FAILED_PRECONDITION"]);

/** The `brain` function's URL, next to the pairing one (production and emulators alike). */
export function brainUrl(pairUrl: string): string {
  return pairUrl.replace(/pairRunnerWithCode\/?$/, "brain");
}

/**
 * The One Week Apps brain as seen from the Mac: every call goes to Studio with the Mac's token.
 * The know-how itself never lives here; only its conclusions for the task come back.
 */
export class StudioBrain implements Brain {
  constructor(
    private readonly session: StudioSession,
    private readonly url: string = brainUrl(session.config.pairUrl),
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  brief(request: BriefRequest): Promise<Brief> {
    return this.call("brief", request);
  }

  review(request: ReviewRequest): Promise<UxReview> {
    let bytes = 0;
    const captures = request.captures.filter((capture) => (bytes += capture.image.byteLength) <= MAX_CAPTURE_BYTES);
    if (captures.length < request.captures.length) this.log(`[brain] ${request.captures.length - captures.length} screenshots not reviewed (too heavy for one call)`);
    return this.call("review", {
      ...request,
      captures: captures.map((capture) => ({ ...capture, image: Buffer.from(capture.image).toString("base64") })),
    });
  }

  reviewCode(request: CodeReviewRequest): Promise<CodeReview> {
    return this.call("reviewCode", request);
  }

  proposeLesson(request: LessonRequest): Promise<Lesson | null> {
    return this.call("proposeLesson", request);
  }

  async learn(lesson: Lesson): Promise<void> {
    await this.call("learn", lesson);
  }

  async forget(lesson: Lesson): Promise<void> {
    await this.call("forget", lesson);
  }

  /** Firebase callable protocol: `{ data }` in, `{ result }` or `{ error }` out. */
  private async call<T>(action: string, request: unknown): Promise<T> {
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${await this.session.token()}` },
      body: JSON.stringify({ data: { action, request } }),
    });
    const body = (await res.json().catch(() => ({}))) as { result?: T; error?: { status?: string; message?: string } };
    if (body.error && REFUSALS.has(body.error.status ?? "")) throw new BrainRefusal(body.error.message ?? "Studio a refusé l'appel.");
    if (!res.ok || body.error) throw new StudioBrainError(`Studio brain: ${body.error?.message ?? `HTTP ${res.status}`}`);
    const result = body.result as T;
    const cost = (result as { trace?: { costUsd?: number } } | null)?.trace?.costUsd;
    if (cost !== undefined) this.log(`[brain] ${action}: $${cost.toFixed(3)}`);
    return result;
  }
}
