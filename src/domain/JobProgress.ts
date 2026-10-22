import { RUNNER_MARKER } from "./Reply.js";

/** An attempt's stages, in order: the brain frames the Mac's work (instructions before, UX and code review after). */
export const STAGES = ["brief", "checkout", "dev", "build", "test", "captures", "review"] as const;
export type Stage = (typeof STAGES)[number];
export type StageStatus = "started" | "passed" | "failed";

export interface StageEntry {
  status: StageStatus;
  startedAt?: string;
  endedAt?: string;
  /** What is happening right now, e.g. "3 fichiers modifiés : A.swift, B.swift". */
  detail?: string;
}
export type ProgressMap = Partial<Record<Stage, StageEntry>>;

const LABEL: Record<Stage, string> = {
  brief: "Consignes",
  checkout: "Préparation du dépôt",
  dev: "Claude Code développe",
  build: "Build",
  test: "Tests sur simulateur",
  captures: "Captures",
  review: "Relecture UX et code",
};
const ICON: Record<StageStatus | "pending", string> = { started: "⏳", passed: "✅", failed: "❌", pending: "⏸" };

/** "13 s", "1 min 12". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const rest = seconds % 60;
  return `${Math.floor(seconds / 60)} min ${String(rest).padStart(2, "0")}`;
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

/** A stage recorded at a point in time: start, end and detail accumulate. Older entries (a bare status) remain readable. */
export function recordStage(progress: ProgressMap, stage: Stage, status: StageStatus, at: string, detail?: string): ProgressMap {
  const previous = normalized(progress)[stage];
  const entry: StageEntry = {
    status,
    startedAt: status === "started" ? previous?.startedAt ?? at : previous?.startedAt,
    endedAt: status === "started" ? undefined : at,
    detail: status === "started" ? detail ?? previous?.detail : undefined,
  };
  return { ...normalized(progress), [stage]: entry };
}

function normalized(progress: ProgressMap): ProgressMap {
  return Object.fromEntries(Object.entries(progress).map(([stage, entry]) =>
    [stage, typeof entry === "string" ? { status: entry } : entry])) as ProgressMap;
}

function line(stage: Stage, entry: StageEntry | undefined): string {
  const head = `- ${ICON[entry?.status ?? "pending"]} ${LABEL[stage]}`;
  if (!entry) return head;
  if (entry.status === "started") {
    const since = entry.startedAt ? ` · depuis ${clock(entry.startedAt)}` : "";
    return `${head}${since}${entry.detail ? ` · ${entry.detail}` : ""}`;
  }
  return entry.startedAt && entry.endedAt
    ? `${head} · ${formatDuration(Date.parse(entry.endedAt) - Date.parse(entry.startedAt))}`
    : head;
}

/** The "Tentative lancée" comment, updated in place at each stage; `note` says why it is still running (an internal fix). */
export const JobProgress = {
  render(attempt: number, branch: string, progress: ProgressMap, note?: string): string {
    const entries = normalized(progress);
    return [
      RUNNER_MARKER,
      `🏗️ **Tentative ${attempt} lancée** sur la branche \`${branch}\`. Résultat ici dans quelques minutes.`,
      ...(note ? ["", note] : []),
      "",
      ...STAGES.map((stage) => line(stage, entries[stage])),
    ].join("\n");
  },
};
