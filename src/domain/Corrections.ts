import type { CodeReview, Remark, UxReview } from "../adapters/Brain.js";

interface AttemptOutcome {
  buildStatus: "pending" | "passed" | "failed";
  testStatus: "pending" | "passed" | "failed";
  failedTests?: string[];
}

/**
 * What the Runner fixes on its own before delivering: a broken build, failing tests, UX review remarks
 * on the task and on its own harness (tests, screenshots), and code review remarks. Out-of-scope remarks
 * are not part of it: they become task suggestions.
 */
export const Corrections = {
  /** Each item: its label (listed, collapsed, in the report) and its fix (for Claude Code). */
  from(outcome: AttemptOutcome, ux: UxReview | null, code: CodeReview | null = null): Remark[] {
    const points: Remark[] = [];
    if (outcome.buildStatus === "failed") points.push({ label: "Build cassé", fix: "Le build échoue : corrige les erreurs de compilation." });
    const failed = outcome.failedTests ?? [];
    const causes = Corrections.failures(failed);
    // The developer reads "Tests : 3 en échec"; Claude Code gets each cause with its tests.
    causes.forEach((cause) => points.push({ label: Corrections.failureLabel(cause), fix: cause }));
    if (outcome.testStatus === "failed" && failed.length === 0) points.push({ label: "Tests en échec", fix: "Des tests échouent : corrige le code (pas les tests existants)." });
    if (ux) points.push(...ux.remarks, ...(ux.internal ?? []));
    if (code) points.push(...code.remarks);
    return points;
  },

  /**
   * Failing tests, one item per cause: a crashing app fails dozens of tests for a single reason.
   * Input lines read "Suite/test (device) : message"; the same message means the same cause.
   */
  failures(failedTests: string[]): string[] {
    const byCause = new Map<string, string[]>();
    for (const line of failedTests) {
      const split = line.indexOf(" : ");
      const cause = split < 0 ? line : line.slice(split + 3);
      byCause.set(cause, [...(byCause.get(cause) ?? []), line]);
    }
    return [...byCause.entries()].map(([cause, lines]) => {
      if (lines.length === 1) return `Test en échec : ${lines[0]}`;
      const names = lines.map((line) => line.slice(0, line.indexOf(" : ")).replace(/\s*\([^)]*\)$/, ""));
      const examples = names.slice(0, 3).join(", ") + (names.length > 3 ? "…" : "");
      return `${lines.length} tests en échec, même cause : ${cause} (${examples})`;
    });
  },

  /** "3 tests en échec, même cause : …" → "Tests : 3 en échec"; "Test en échec : …" → "Test en échec". */
  failureLabel(cause: string): string {
    const many = /^(\d+) tests en échec/.exec(cause);
    return many ? `Tests : ${many[1]} en échec` : "Test en échec";
  },

  /** Tests already failing before the task: a single out-of-scope item, listing each test for the task that will fix them. */
  preexisting(failedTests: string[], baseBranch: string): Remark | null {
    if (failedTests.length === 0) return null;
    const label = failedTests.length > 1 ? `Tests : ${failedTests.length} déjà en échec avant la tâche` : "Test déjà en échec avant la tâche";
    return { label, fix: [`Ces tests échouent déjà sur ${baseBranch} : répare-les sans changer le comportement de l'app.`, ...failedTests.map((test) => `- ${test}`)].join("\n") };
  },

  feedback(points: Remark[]): string {
    const line = ({ label, fix }: Remark) => (label === fix ? `- ${fix}` : `- ${label} → ${fix}`);
    return ["Vérification automatique de la tentative précédente : corrige ces points, sans rien changer d'autre.", ...points.map(line)].join("\n");
  },
};
