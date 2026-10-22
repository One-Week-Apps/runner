import type { CriterionCheck } from "../adapters/Brain.js";

/**
 * Each "done" criterion is checked where it shows: on the screenshots first (UX review), otherwise
 * in the diff (code review). When neither can check it, it stays without a verdict, never failed.
 */
export const Criteria = {
  merge(ux: CriterionCheck[] = [], code: CriterionCheck[] = []): CriterionCheck[] {
    const inCode = (label: string) => code.find((check) => check.label === label && check.met !== undefined);
    const base = ux.length ? ux : code;
    return base.map(({ label, met }) => {
      if (ux.length && met !== undefined) return { label, met, by: "ux" as const };
      const found = inCode(label);
      return found ? { label, met: found.met, by: "code" as const } : { label };
    });
  },
};
