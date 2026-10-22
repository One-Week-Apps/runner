import { describe, expect, it } from "vitest";
import { RUNNER_MARKER } from "../src/domain/Reply.js";
import { TaskReport, stepLabel, type ReportCapture } from "../src/domain/TaskReport.js";

const cap = (scenario: string, step: string, device: string, at: string): ReportCapture => ({
  scenario, step, device, imageUrl: `https://img/${scenario}/${step}/${device}.png`, capturedAt: at,
});

describe("TaskReport: an attempt's result comment", () => {
  const captures = [
    cap("testJouerLeNiveau1", "Accueil", "iPhone 17e", "2026-10-15T10:00:01Z"),
    cap("testJouerLeNiveau1", "Accueil", "iPhone 18 Pro Max", "2026-10-15T10:00:02Z"),
    cap("testJouerLeNiveau1", "Niveau1", "iPhone 17e", "2026-10-15T10:00:05Z"),
    cap("testJouerLeNiveau1", "Niveau1", "iPhone 18 Pro Max", "2026-10-15T10:00:06Z"),
    cap("testActiverVoiceOver", "Alerte", "iPhone 17e", "2026-10-15T10:01:00Z"),
  ];

  it("heads with attempt, build, tests and scenario count", () => {
    const md = TaskReport.render({ attempt: 2, buildStatus: "passed", testStatus: "passed", captures });
    expect(md.startsWith(RUNNER_MARKER)).toBe(true);
    expect(md).toContain("**Tentative 2** · Build ✅ · Tests ✅ · 2 scénarios");
  });

  it("renders one block per scenario, numbered in run order, steps in order", () => {
    const md = TaskReport.render({ attempt: 1, buildStatus: "passed", testStatus: "passed", captures });
    const s1 = md.indexOf("Scénario 1 : Jouer le niveau 1");
    const s2 = md.indexOf("Scénario 2 : Activer voice over");
    expect(s1).toBeGreaterThan(0);
    expect(s2).toBeGreaterThan(s1);
    expect(md).toContain("| 1.1 · Accueil |");
    expect(md).toContain("| 1.2 · Niveau 1 |");
  });

  it("shows the target screen first (last step) and collapses the intermediate ones", () => {
    const md = TaskReport.render({ attempt: 1, buildStatus: "passed", testStatus: "passed", captures });
    const folded = md.indexOf("<summary>Étapes intermédiaires (1)</summary>");
    expect(md.indexOf("| 1.2 · Niveau 1 |")).toBeLessThan(folded);
    expect(folded).toBeLessThan(md.indexOf("| 1.1 · Accueil |"));
    expect(md).not.toContain("Étapes intermédiaires (0)");
  });

  it("puts the task's scenarios first, expanded, before generic journeys", () => {
    const md = TaskReport.render({ attempt: 1, buildStatus: "passed", testStatus: "passed", captures: [
      cap("testAppLaunches", "FirstScreen", "iPhone 17e", "2026-10-15T10:00:00Z"),
      { ...cap("testAfficherLaVersion", "Accueil", "iPhone 17e", "2026-10-15T10:00:10Z"), forTask: true },
      cap("testSousTitre", "Niveaux", "iPhone 17e", "2026-10-15T10:00:20Z"),
    ] });
    expect(md).toContain("<details open>\n<summary><b>Scénario 1 : Afficher la version</b></summary>");
    expect(md).toContain("<details>\n<summary><b>Scénario 2 : App launches</b></summary>");
    expect(md.indexOf("Scénario 3 : Sous titre")).toBeGreaterThan(0);
  });

  it("renders one column per device, empty when a screenshot is missing", () => {
    const md = TaskReport.render({ attempt: 1, buildStatus: "passed", testStatus: "passed", captures });
    expect(md).toContain("| Étape | iPhone 17e | iPhone 18 Pro Max |");
    expect(md).toContain('<img src="https://img/testJouerLeNiveau1/Niveau1/iPhone 18 Pro Max.png" width="160">');
    expect(md).toMatch(/\| 2\.1 · Alerte \| <img[^|]+\| — \|/);
  });

  it("shows a failure status with the same next steps", () => {
    const md = TaskReport.render({ attempt: 1, buildStatus: "failed", testStatus: "pending", captures: [] });
    expect(md).toContain("Build ❌ · Tests ⏸");
    expect(md).toContain("Aucune capture");
    expect(md).toContain("`KO 1.2 : ton retour`");
  });

  it("names each failing test with its device and message", () => {
    const md = TaskReport.render({
      attempt: 1, buildStatus: "passed", testStatus: "failed", captures,
      failedTests: ["LoadLevelViewControllerTests/test_subtitle (iPhone 18 Pro Max) : XCTAssertTrue failed"],
    });
    expect(md).toContain("**Tests en échec**");
    expect(md).toContain("- `LoadLevelViewControllerTests/test_subtitle (iPhone 18 Pro Max) : XCTAssertTrue failed`");
  });

  it("links to the attempt's code just before the next steps", () => {
    const md = TaskReport.render({ attempt: 1, buildStatus: "passed", testStatus: "passed", captures, codeUrl: "https://github.com/o/r/compare/main...aitasker/issue-7" });
    expect(md).toContain("🔎 [Voir le code de la tentative](https://github.com/o/r/compare/main...aitasker/issue-7)");
    expect(md.indexOf("Voir le code")).toBeLessThan(md.indexOf("Réponds :"));
  });

  it("says the UX review has nothing to add only when there is no remark", () => {
    const clean = TaskReport.render({ attempt: 1, buildStatus: "passed", testStatus: "passed", captures, ux: { verdict: "ok", remarks: [] } });
    const minor = TaskReport.render({ attempt: 1, buildStatus: "passed", testStatus: "passed", captures, ux: { verdict: "ok", remarks: ["Espacement à 16 pt"] } });
    const blocking = TaskReport.render({ attempt: 1, buildStatus: "passed", testStatus: "passed", captures, ux: { verdict: "to_fix", remarks: ["Bouton à 32 pt"] } });
    expect(clean).toContain("👀 **Relecture UX** : rien à redire.");
    expect(minor).toContain("👀 **Relecture UX** : bon, quelques remarques");
    expect(minor).not.toContain("rien à redire");
    expect(blocking).toContain("👀 **Relecture UX** : à corriger");
  });

  it("collapses internal fixes and lists out-of-scope remarks with their add link", () => {
    const md = TaskReport.render({
      attempt: 3, buildStatus: "passed", testStatus: "passed", captures,
      internalRounds: 2,
      fixedInternally: ["Version masquée par les tuiles", "Capture prise trop tôt"],
      outOfScope: [{ text: "Titres de chapitres en taille fixe", newTaskUrl: "https://github.com/o/r/issues/new?title=Titres" }],
    });
    expect(md).toContain("**Tentative 3** · Build ✅ · Tests ✅ · 2 scénarios · 2 corrections internes");
    expect(md).toContain("<summary>🔁 2 corrections internes avant de te livrer : 2 points traités</summary>");
    expect(md).toContain("- Titres de chapitres en taille fixe · [➕ Ajouter](https://github.com/o/r/issues/new?title=Titres)");
  });

  it("escapes test text in the Markdown", () => {
    const md = TaskReport.render({ attempt: 1, buildStatus: "passed", testStatus: "passed",
      captures: [cap("testX", "a|b<script>", "iPhone 17e", "2026-10-15T10:00:00Z")] });
    expect(md).not.toContain("<script>");
    expect(md).toContain("A\\|b&lt;script&gt;");
  });
});

describe("TaskReport: readable by the developer", () => {
  it("spells out screen variants", () => {
    expect(stepLabel("AccueilTexteAgrandi")).toBe("Accueil · Accessibilité · Dynamic Type");
    expect(stepLabel("AccueilGrandeTaille")).toBe("Accueil · Accessibilité · Dynamic Type");
    expect(stepLabel("ChoixNiveauModeSombre")).toBe("Choix niveau · Dark mode");
    expect(stepLabel("Accueil")).toBe("Accueil");
  });

  it("follows the target screenshot with its VoiceOver reading, one arrow per swipe", () => {
    const md = TaskReport.render({ attempt: 1, buildStatus: "passed", testStatus: "passed", captures: [
      { ...cap("testTitre", "Accueil", "iPhone 17e", "2026-10-15T10:00:00Z"), voiceOver: ["Choisis ton niveau", "Chapitre 1 : Ice Cave, bouton"] },
    ] });
    expect(md).toContain("🔊 **VoiceOver** : Choisis ton niveau → Chapitre 1 : Ice Cave, bouton");
  });
});

