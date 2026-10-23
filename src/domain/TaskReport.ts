import { RUNNER_MARKER } from "./Reply.js";

type Status = "pending" | "passed" | "failed";

export interface ReportCapture {
  scenario: string;
  step: string;
  device: string;
  imageUrl: string;
  capturedAt: string;
  /** A screenshot from a UI test the task wrote or changed: it shows the screen the task is about. */
  forTask?: boolean;
  /** What VoiceOver would read on this screen, in swipe-right order. */
  voiceOver?: string[];
}

const VARIANTS: [RegExp, string][] = [
  [/(TexteAgrandi|GrandeTaille|GrandTexte|DynamicType|LargeText|Accessibilite|Accessibility)$/, "Accessibilité · Dynamic Type"],
  [/(ModeSombre|Sombre|DarkMode|Dark)$/, "Dark mode"],
];

/** "AccueilTexteAgrandi" → "Accueil · Accessibilité · Dynamic Type"; "ChoixNiveau" → "Choix niveau". */
export function stepLabel(step: string): string {
  const human = (words: string) => {
    const spaced = words.replace(/([a-zà-ÿ])([A-Z0-9])/g, "$1 $2").trim();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
  };
  for (const [suffix, label] of VARIANTS) {
    const base = step.replace(suffix, "");
    if (base !== step) return base ? `${human(base)} · ${label}` : label;
  }
  return human(step);
}

/** The VoiceOver reading, one swipe right between elements. */
export function voiceOverLine(items: string[]): string {
  return items.join(" → ");
}

export interface ReportInput {
  attempt: number;
  buildStatus: Status;
  testStatus: Status;
  captures: ReportCapture[];
  /** The brain's UX review of the screenshots; absent when not requested or unavailable. */
  ux?: { verdict: "ok" | "to_fix"; remarks: string[] } | null;
  /** The code reviewer's reading of the diff; absent without a diff or when unavailable. */
  codeReview?: { verdict: "ok" | "to_fix"; remarks: string[] } | null;
  /** Failing tests as named by the compute agent: "Suite/test (device) : message". */
  failedTests?: string[];
  /** The attempt's diff, to read the code before replying. */
  codeUrl?: string;
  /** Items the Runner fixed on its own before delivering (collapsed). */
  fixedInternally?: string[];
  /** Attempts the Runner restarted on its own before this report. */
  internalRounds?: number;
  /** Out-of-scope remarks, each with the link that turns it into a new task. */
  /** `text`: the short label shown; `fix`: the decided fix, sent as is when the remark is added. */
  outOfScope?: { text: string; fix?: string; newTaskUrl: string }[];
  /** "Done" criteria written with the instructions, checked by the reviewers. */
  criteria?: { label: string; met?: boolean; by?: "ux" | "code" }[];
  /** The Runner started from the raw task: the brain's instructions never arrived. */
  fallback?: boolean;
  /** Why Studio was not used, in the developer's words (quota reached, review not included…). */
  notice?: string;
  /** Knowledge version and model of each brain call (collapsed). */
  trace?: { brief?: Provenance; review?: Provenance; code?: Provenance };
  /** Other unmerged tasks touching the same files: a conflict is coming. */
  relatedBranches?: { branch: string; files: string[] }[];
  /** Screenshots the Runner could not publish (permissions, network). */
  lostCaptures?: number;
  /** A lesson the brain offers to learn after the reviewers missed something. */
  lesson?: { text: string; scope: string };
  /** Estimated cost of the delivery in dollars (list prices): brain calls plus Claude Code's work. */
  cost?: { brain: number; dev: number };  /** Other tasks' consignes carried by this attempt (same screen): one report and one reply for all. */
  grouped?: string[];
}

interface Provenance {
  knowledge: string;
  model: string;
}

/** "toutes tes apps" or the app's name. */
export function lessonScope(scope: string): string {
  return scope === "all" ? "toutes tes apps" : scope;
}

/** "1,85 $" */
function dollars(amount: number): string {
  return `${amount.toFixed(2).replace(".", ",")} $`;
}

const ICON: Record<Status, string> = { passed: "✅", failed: "❌", pending: "⏸" };

function safeUrl(url: string): string {
  return url.replace(/</g, "%3C").replace(/>/g, "%3E").replace(/"/g, "%22");
}

function escape(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** "testJouerLeNiveau1" → "Jouer le niveau 1" */
function scenarioTitle(method: string): string {
  const words = method
    .replace(/^test/, "")
    .replace(/([a-z])([A-Z0-9])/g, "$1 $2")
    .replace(/([0-9])([A-Za-z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Order of first appearance in time. */
function ordered<T>(items: T[], key: (item: T) => string, at: (item: T) => string): string[] {
  const first = new Map<string, string>();
  for (const item of items) {
    const k = key(item);
    if (!first.has(k) || at(item) < first.get(k)!) first.set(k, at(item));
  }
  return [...first.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([k]) => k);
}

/** The result comment: one collapsible block per scenario, as a steps × devices table. */
export const TaskReport = {
  render(input: ReportInput): string {
    const { captures } = input;
    // The task's scenarios first: the developer comes to judge the target screen.
    const inOrder = ordered(captures, (c) => c.scenario, (c) => c.capturedAt);
    const forTask = new Set(captures.filter((c) => c.forTask).map((c) => c.scenario));
    const scenarios = [...inOrder.filter((s) => forTask.has(s)), ...inOrder.filter((s) => !forTask.has(s))];
    const devices = ordered(captures, (c) => c.device, (c) => c.capturedAt);
    const plural = scenarios.length > 1 ? "s" : "";
    const rounds = input.internalRounds ?? 0;
    const corrections = `${rounds} correction${rounds > 1 ? "s" : ""} interne${rounds > 1 ? "s" : ""}`;
    const lines = [
      RUNNER_MARKER,
      `🤖 **Tentative ${input.attempt}** · Build ${ICON[input.buildStatus]} · Tests ${ICON[input.testStatus]} · ${scenarios.length} scénario${plural}${rounds ? ` · ${corrections}` : ""}`,
      "",
    ];

    if (input.grouped?.length) {
      lines.push(`🧩 Regroupe aussi : ${input.grouped.map(escape).join(" · ")}. Ta réponse vaut pour toutes.`, "");
    }

    if (input.notice) {
      lines.push(`ℹ️ ${escape(input.notice)}`, "");
    } else if (input.fallback) {
      lines.push("⚠️ Consignes non reçues : le Runner est parti de la tâche telle qu'écrite.", "");
    }

    if (input.lostCaptures) {
      const n = input.lostCaptures;
      lines.push(`⚠️ ${n} capture${n > 1 ? "s" : ""} non publiée${n > 1 ? "s" : ""} : le stockage les a refusées.`, "");
    }

    if (captures.length === 0) {
      lines.push("Aucune capture pour cette tentative.", "");
    }

    scenarios.forEach((scenario, s) => {
      const inScenario = captures.filter((c) => c.scenario === scenario);
      const steps = ordered(inScenario, (c) => c.step, (c) => c.capturedAt);
      lines.push(
        `<details${scenarios.length <= 2 || (forTask.size ? forTask.has(scenario) : s === 0) ? " open" : ""}>`,
        `<summary><b>Scénario ${s + 1} : ${escape(scenarioTitle(scenario))}</b></summary>`,
      );
      const header = [`| Étape | ${devices.map(escape).join(" | ")} |`, `|---|${devices.map(() => "---").join("|")}|`];
      const row = (step: string, e: number) => {
        const cells = devices.map((device) => {
          const shot = inScenario.find((c) => c.step === step && c.device === device);
          return shot ? `<img src="${safeUrl(shot.imageUrl)}" width="160">` : "—";
        });
        return `| ${s + 1}.${e + 1} · ${escape(stepLabel(step))} | ${cells.join(" | ")} |`;
      };
      // The target screen is the journey's last step: it shows on its own, the path to it is collapsed.
      const last = steps.length - 1;
      lines.push("", ...header, row(steps[last], last), "");
      const reading = inScenario.find((c) => c.step === steps[last] && c.voiceOver?.length)?.voiceOver;
      if (reading) lines.push(`🔊 **VoiceOver** : ${escape(voiceOverLine(reading))}`, "");
      if (last > 0) {
        lines.push(
          `<details><summary>Étapes intermédiaires (${last})</summary>`, "",
          ...header, ...steps.slice(0, last).map(row), "", "</details>", "",
        );
      }
      lines.push("</details>", "");
    });

    if (input.failedTests?.length) {
      lines.push("❌ **Tests en échec**");
      input.failedTests.forEach((name) => lines.push(`- \`${name.replace(/`/g, "'")}\``));
      lines.push("");
    }

    if (input.criteria?.length) {
      lines.push("🎯 **Critères de fini**");
      input.criteria.forEach(({ label, met, by }) => {
        if (met === undefined) lines.push(`- ❔ ${escape(label)} · non vérifiable`);
        else lines.push(`- ${met ? "✅" : "❌"} ${escape(label)}${by === "code" ? " · vu dans le code" : ""}`);
      });
      lines.push("");
    }

    if (input.ux) {
      const { verdict, remarks } = input.ux;
      lines.push(verdict === "to_fix" ? "👀 **Relecture UX** : à corriger"
        : remarks.length ? "👀 **Relecture UX** : bon, quelques remarques" : "👀 **Relecture UX** : rien à redire.");
      input.ux.remarks.forEach((remark) => lines.push(`- ${escape(remark)}`));
      lines.push("");
    }

    if (input.codeReview) {
      const { verdict, remarks } = input.codeReview;
      lines.push(verdict === "to_fix" ? "🔍 **Revue de code** : à corriger"
        : remarks.length ? "🔍 **Revue de code** : bon, quelques remarques" : "🔍 **Revue de code** : rien à redire.");
      remarks.forEach((remark) => lines.push(`- ${escape(remark)}`));
      lines.push("");
    }

    if (input.outOfScope?.length) {
      lines.push("💡 **Hors du périmètre de cette tâche**");
      input.outOfScope.forEach(({ text, newTaskUrl }) => lines.push(`- ${escape(text)} · [➕ Ajouter](${safeUrl(newTaskUrl)})`));
      lines.push("");
    }

    if (input.relatedBranches?.length) {
      const list = input.relatedBranches.map(({ branch, files }) => `${escape(branch)} (${files.map(escape).join(", ")})`).join(" · ");
      lines.push(`🔀 **Pas encore fusionné, touche les mêmes fichiers** : ${list}`, "");
    }

    if (input.lesson) {
      lines.push(`📚 Si tu valides, Studio retiendra pour ${lessonScope(input.lesson.scope)} : ${escape(input.lesson.text)}`, "");
    }

    if (input.fixedInternally?.length) {
      const n = input.fixedInternally.length;
      lines.push(
        `<details><summary>🔁 ${corrections} avant de te livrer : ${n} point${n > 1 ? "s" : ""} traité${n > 1 ? "s" : ""}</summary>`, "",
        ...input.fixedInternally.map((point) => `- ${escape(point)}`),
        "", "</details>", "",
      );
    }

    const passes = ([["Consignes", input.trace?.brief], ["Relecture UX", input.trace?.review], ["Relecture du code", input.trace?.code]] as const)
      .filter(([, provenance]) => provenance)
      .map(([name, provenance]) => `- ${name} : version ${escape(provenance!.knowledge)} · ${escape(provenance!.model)}`);
    if (input.cost) {
      const { brain, dev } = input.cost;
      passes.push(`- Coût estimé : ${dollars(brain + dev)} (Studio ${dollars(brain)} · Claude Code ${dollars(dev)})`);
    }
    if (passes.length) {
      lines.push("<details><summary>🧾 Traçabilité</summary>", "", ...passes, "", "</details>", "");
    }

    if (input.codeUrl) {
      lines.push(`🔎 [Voir le code de la tentative](${safeUrl(input.codeUrl)})`, "");
    }

    lines.push("Réponds : `OK` pour valider · ou `KO 1.2 : ton retour` (scénario.étape) pour une nouvelle tentative.");
    return lines.join("\n");
  },
};
