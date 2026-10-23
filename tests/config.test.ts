import { describe, expect, it } from "vitest";
import { parseRunnerConfig } from "../src/infrastructure/config.js";

describe("~/.aitasker/config.json", () => {
  it("fills in the GitHub clone URL and keeps the base branch", () => {
    const config = parseRunnerConfig({
      tracker: "github", allowedAuthors: ["octocat"], label: "aitasker",
      repos: { "One-Week-Apps/EscapeFromBlindness": { baseBranch: "chore/xcode27" } },
    });
    expect(config.repos["One-Week-Apps/EscapeFromBlindness"]).toEqual({
      baseBranch: "chore/xcode27", cloneUrl: "https://github.com/One-Week-Apps/EscapeFromBlindness.git", merge: "trunk",
    });
    expect(config.label).toBe("aitasker");
  });

  it("merges after an OK by default, or leaves the pull request to the developer", () => {
    const config = parseRunnerConfig({
      tracker: "github", allowedAuthors: ["octocat"],
      repos: { "a/trunk": { baseBranch: "main" }, "a/pr": { baseBranch: "main", merge: "pr" } },
    });
    expect(config.repos["a/trunk"].merge).toBe("trunk");
    expect(config.repos["a/pr"].merge).toBe("pr");
    expect(() => parseRunnerConfig({ tracker: "github", allowedAuthors: ["x"], repos: { "a/b": { baseBranch: "main", merge: "auto" } } })).toThrow();
  });

  it("rejects a configuration without an allowed author (security)", () => {
    expect(() => parseRunnerConfig({ tracker: "github", allowedAuthors: [], repos: { "a/b": { baseBranch: "main" } } })).toThrow();
  });

  it("rejects a malformed repository name", () => {
    expect(() => parseRunnerConfig({ tracker: "github", allowedAuthors: ["x"], repos: { "pas-un-slug": { baseBranch: "main" } } })).toThrow();
  });
});
