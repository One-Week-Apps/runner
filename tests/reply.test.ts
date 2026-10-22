import { describe, expect, it } from "vitest";
import { Reply } from "../src/domain/Reply.js";

function ko(text: string) {
  const reply = Reply.parse(text);
  if (reply?.kind !== "ko") throw new Error(`not a KO: ${text}`);
  return reply;
}

describe("Reply: the user's answer in the thread", () => {
  it.each(["OK", "ok", " Ok ", "OK 👍", "ok merci"])("accepts \"%s\" as OK", (text) => {
    expect(Reply.parse(text)).toEqual({ kind: "ok" });
  });

  it("parses a KO with scenario and step", () => {
    expect(Reply.parse("KO 1.2 : le texte de l'alerte est coupé")).toEqual({
      kind: "ko", scenario: 1, step: 2, feedback: "le texte de l'alerte est coupé",
    });
  });

  it("parses a KO with only a scenario, or without a reference", () => {
    expect(Reply.parse("ko 2: bouton trop petit")).toMatchObject({ kind: "ko", scenario: 2, step: null, feedback: "bouton trop petit" });
    expect(Reply.parse("KO : rien ne s'affiche")).toMatchObject({ kind: "ko", scenario: null, step: null, feedback: "rien ne s'affiche" });
    expect(Reply.parse("KO le fond est blanc")).toMatchObject({ kind: "ko", feedback: "le fond est blanc" });
  });

  it("does not treat a bare KO or a free-form comment as a reply", () => {
    expect(Reply.parse("KO")).toBeNull();
    expect(Reply.parse("KO 1.2 :")).toBeNull();
    expect(Reply.parse("joli travail")).toBeNull();
    expect(Reply.parse("okay je regarde demain")).toBeNull();
  });

  it("never treats the Runner's own comments as replies", () => {
    expect(Reply.parse("<!-- aitasker -->\nOK")).toBeNull();
  });

  it("phrases the feedback for Claude Code", () => {
    expect(Reply.feedbackFor(ko("KO 1.2 : texte coupé"))).toBe("Scénario 1, étape 2 : texte coupé");
    expect(Reply.feedbackFor(ko("KO : tout est flou"))).toBe("tout est flou");
  });

  it("maps each \"N.M :\" line of a multi-screen KO to its scenario and step", () => {
    expect(Reply.feedbackFor(ko("KO 1.2 : titre trop petit\n2.1 : bouton coupé\n2.3 : \nle fond est terne"))).toBe("Scénario 1, étape 2 : titre trop petit\nScénario 2, étape 1 : bouton coupé\nle fond est terne");
  });

  it("recognizes \"OUBLIE\" alone on its line as forgetting the lesson", () => {
    expect(Reply.wantsToForget("OUBLIE")).toBe(true);
    expect(Reply.wantsToForget("oublie")).toBe(true);
    expect(Reply.wantsToForget("KO : j'oublie le bouton")).toBe(false);
    expect(Reply.parse("OUBLIE")).toBeNull();
  });
});
