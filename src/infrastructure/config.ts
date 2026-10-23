import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { StudioConfig } from "./studio/StudioSession.js";

const repos = z.record(
  z.string().regex(/^[\w.-]+\/[\w.-]+$/, "expected a repository as owner/name"),
  z.object({ baseBranch: z.string().min(1), cloneUrl: z.string().url().optional(), merge: z.enum(["trunk", "pr"]).default("trunk") }),
);

const githubSchema = z.object({
  tracker: z.literal("github"),
  allowedAuthors: z.array(z.string().min(1)).min(1, "allowedAuthors: at least one author (Claude Code runs on this Mac)"),
  label: z.string().min(1).default("aitasker"),
  repos,
});

/** Studio: only the paired account files tasks; `repos` lists the repositories this Mac agrees to clone. */
const studioSchema = z.object({
  tracker: z.literal("studio"),
  label: z.string().min(1).default("aitasker"),
  repos,
  studio: z.object({
    projectId: z.string().min(1),
    apiKey: z.string().min(1),
    bucket: z.string().min(1),
    pairUrl: z.string().url(),
    emulators: z.object({ auth: z.string().url(), firestore: z.string().url(), storage: z.string().url() }).optional(),
  }),
});

export type RunnerConfig =
  | { tracker: "github"; allowedAuthors: string[]; label: string; repos: Record<string, RepoConfig> }
  | { tracker: "studio"; label: string; repos: Record<string, RepoConfig>; studio: StudioConfig };

export interface RepoConfig {
  baseBranch: string;
  cloneUrl: string;
  /** After an OK: the Runner merges into the base (`trunk`), or only opens the pull request (`pr`). */
  merge: MergeMode;
}

export type MergeMode = "trunk" | "pr";

export function parseRunnerConfig(raw: unknown): RunnerConfig {
  const parsed = z.discriminatedUnion("tracker", [githubSchema, studioSchema]).parse(raw);
  const withClones = Object.fromEntries(
    Object.entries(parsed.repos).map(([slug, repo]) => [
      slug,
      { baseBranch: repo.baseBranch, cloneUrl: repo.cloneUrl ?? `https://github.com/${slug}.git`, merge: repo.merge },
    ]),
  );
  return { ...parsed, repos: withClones };
}

/** null when the file does not exist: the Runner then starts without polling any tracker. */
export async function loadRunnerConfig(path: string): Promise<RunnerConfig | null> {
  try {
    return parseRunnerConfig(JSON.parse(await readFile(path, "utf-8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
