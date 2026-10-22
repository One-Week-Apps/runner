/** Invisible marker on the Runner's comments: it comments with the user's own account. */
export const RUNNER_MARKER = "<!-- aitasker -->";

export type ParsedReply =
  | { kind: "ok" }
  | { kind: "ko"; scenario: number | null; step: number | null; feedback: string };

const OK = /^ok(?:\s+(?!je\b|on\b)[^\s].*)?$|^ok$/i;
const FORGET = /^\s*oublie\s*$/im;
const KO = /^ko\b\s*(?:(\d+)(?:\.(\d+))?)?\s*:?\s*(.*)$/is;

/** The user's reply in the task thread: OK, or KO with feedback (and an optional target step). */
export const Reply = {
  parse(text: string): ParsedReply | null {
    if (text.includes(RUNNER_MARKER)) return null;
    const clean = text.trim();
    if (/^ok\b/i.test(clean) && !/^okay\b/i.test(clean) && OK.test(clean)) return { kind: "ok" };
    const ko = KO.exec(clean);
    if (!ko) return null;
    const feedback = ko[3].trim();
    if (!feedback) return null;
    return {
      kind: "ko",
      scenario: ko[1] ? Number(ko[1]) : null,
      step: ko[2] ? Number(ko[2]) : null,
      feedback,
    };
  },

  /** "OUBLIE" alone on its line: the lesson learned on approval is forgotten. */
  wantsToForget(text: string): boolean {
    return !text.includes(RUNNER_MARKER) && FORGET.test(text);
  },

  /** The feedback for Claude Code, with each targeted screen ("2.1 : …", one line per screenshot tapped in Focus) spelled out. */
  feedbackFor(reply: Extract<ParsedReply, { kind: "ko" }>): string {
    const where = (scenario: number, step: number | null) => (step === null ? `Scénario ${scenario}` : `Scénario ${scenario}, étape ${step}`);
    const [first, ...rest] = reply.feedback.split("\n");
    const head = reply.scenario === null ? first : `${where(reply.scenario, reply.step)} : ${first}`;
    const more = rest.flatMap((line) => {
      const aimed = /^(\d+)\.(\d+)\s*:\s*(.*)$/.exec(line.trim());
      if (!aimed) return line.trim() ? [line.trim()] : [];
      return aimed[3].trim() ? [`${where(Number(aimed[1]), Number(aimed[2]))} : ${aimed[3].trim()}`] : [];
    });
    return [head, ...more].join("\n");
  },
};
