import type { TaskSize } from "../adapters/Brain.js";
import type { Touch, TrackedTask } from "./TrackedTask.js";

/** How a waiting reason carries Studio's question: Focus shows it with an answer field. */
export const QUESTION_PREFIX = "Studio demande : ";

/** At most this many consignes in one attempt: the report stays readable and the attempt short. */
export const MAX_GROUP = 3;

const SIZE_ORDER: Record<TaskSize, number> = { s: 0, m: 1, l: 2 };

export interface Plan {
  /** The task to run now, and the queued ones that ride along its attempt. */
  start: { task: TrackedTask; members: TrackedTask[] } | null;
  /** Why each other queued task waits, in the developer's words. */
  waiting: { task: TrackedTask; reason: string }[];
}

/** What two tasks both touch: a common screen or file, or both shared code. Unknown footprints never clash. */
export function overlap(a: Touch | null, b: Touch | null): string[] {
  if (!a || !b) return [];
  const screens = a.screens.filter((s) => b.screens.some((o) => o.toLowerCase() === s.toLowerCase()));
  const files = a.files.filter((f) => b.files.includes(f));
  const shared = a.shared && b.shared && screens.length === 0 && files.length === 0 ? ["le code partagé"] : [];
  return [...screens.map((s) => `l'écran ${s}`), ...files, ...shared];
}

/** Internal fix first (the developer waits for its report), then a KO (context in mind), then follow-ups, then the rest. */
function urgency(task: TrackedTask): number {
  if (task.internalRounds > 0) return 3;
  if (task.isDeveloperRetry) return 2;
  return task.tracker.followUp ? 1 : 0;
}

/** Can ride along another attempt: a first, small, local task Studio has read. */
function groupable(task: TrackedTask): boolean {
  const footprint = task.footprint;
  return task.attempt === 0 && !task.pendingQuestion && !!footprint && footprint.size === "s" && !footprint.shared;
}

/**
 * One Runner, non-preemptive: when it is free, the most urgent eligible task starts, in the developer's
 * order. A task waits while a delivered one (running, awaiting a reply, or validated but not merged)
 * touches the same screen or file; small tasks on the same screen ride along a single attempt instead.
 */
export const Scheduler = {
  plan(tasks: TrackedTask[], lastRepo: string | null = null): Plan {
    const holders = tasks.filter((t) => t.is("running") || t.is("awaiting_reply") || (t.is("validated") && t.awaitingMerge));
    const queued = tasks.filter((t) => t.is("queued")).sort((a, b) =>
      urgency(b) - urgency(a)
      || (a.tracker.rank ?? Infinity) - (b.tracker.rank ?? Infinity)
      || Number(b.tracker.repo === lastRepo) - Number(a.tracker.repo === lastRepo)
      || SIZE_ORDER[a.footprint?.size ?? "m"] - SIZE_ORDER[b.footprint?.size ?? "m"]
      || a.discoveredAt.localeCompare(b.discoveredAt));
    const busy = tasks.some((t) => t.is("running"));

    const blockerOf = (task: TrackedTask) => {
      if (task.internalRounds > 0) return null; // already this task's own attempt
      for (const holder of holders) {
        const common = overlap(task.touch, holder.touch);
        if (holder.key !== task.key && holder.tracker.repo === task.tracker.repo && common.length) return { holder, common };
      }
      return null;
    };

    let start: Plan["start"] = null;
    const waiting: Plan["waiting"] = [];
    const absorbed = new Set<string>();
    for (const task of queued) {
      if (absorbed.has(task.key)) continue;
      if (task.pendingQuestion) {
        // Focus reads this prefix to show the question with an answer field.
        waiting.push({ task, reason: `${QUESTION_PREFIX}${task.pendingQuestion}` });
        continue;
      }
      const blocked = blockerOf(task);
      if (blocked) {
        const merge = blocked.holder.is("validated") ? "que tu fusionnes" : "";
        waiting.push({ task, reason: `Attend ${merge ? `${merge} ` : ""}« ${blocked.holder.tracker.title} » : touche aussi ${blocked.common.join(", ")}.` });
        continue;
      }
      if (!busy && !start) {
        const members = groupable(task)
          ? queued.filter((other) => other !== task && other.tracker.repo === task.tracker.repo && groupable(other)
            && !blockerOf(other) && overlap(task.touch, other.touch).length > 0).slice(0, MAX_GROUP - 1)
          : [];
        members.forEach((m) => absorbed.add(m.key));
        start = { task, members };
        continue;
      }
      waiting.push({ task, reason: "" });
    }
    return { start, waiting };
  },
};
