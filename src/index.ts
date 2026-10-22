import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createApp } from "./infrastructure/server.js";
import { FetchComputeAgentClient } from "./infrastructure/FetchComputeAgentClient.js";
import { GitHubIssueTracker } from "./infrastructure/GitHubIssueTracker.js";
import { JsonFileTrackedTaskRepository } from "./infrastructure/JsonFileTrackedTaskRepository.js";
import { loadRunnerConfig, type RunnerConfig } from "./infrastructure/config.js";
import { IssueLoop } from "./usecases/IssueLoop.js";
import { JsonlReviewerMisses } from "./infrastructure/JsonlReviewerMisses.js";
import { StudioBrain } from "./infrastructure/studio/StudioBrain.js";
import { StudioIssueTracker } from "./infrastructure/studio/StudioIssueTracker.js";
import { StudioSession, loadSession, saveSession, type StudioConfig } from "./infrastructure/studio/StudioSession.js";
import type { IssueTracker } from "./adapters/IssueTracker.js";

const DATA_DIR = join(homedir(), ".aitasker");
const PORT = Number(process.env.PORT ?? 3939);
/** Only the compute agent on this Mac calls the local API: never listen on the network. */
const HOST = process.env.HOST ?? "127.0.0.1";
const COMPUTE_BASE_URL = process.env.COMPUTE_BASE_URL ?? "http://127.0.0.1:8000";
const CALLBACK_BASE_URL = process.env.CALLBACK_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const CONFIG_PATH = process.env.AITASKER_CONFIG ?? join(DATA_DIR, "config.json");
const TASKS_PATH = process.env.AITASKER_TASKS ?? join(DATA_DIR, "tasks.json");
const POLL_MS = Number(process.env.AITASKER_POLL_SECONDS ?? 10) * 1000;
const MISSES_PATH = process.env.AITASKER_MISSES ?? join(DATA_DIR, "reviewer-misses.jsonl");
const STUDIO_SESSION_PATH = process.env.AITASKER_STUDIO_SESSION ?? join(DATA_DIR, "studio-session.json");
/** In GitHub mode, the Studio settings kept aside: the brain always lives in Studio. */
const STUDIO_CONFIG_PATH = process.env.AITASKER_STUDIO_CONFIG ?? join(DATA_DIR, "config.studio.json");

/** The paired Mac's Studio session, if any; without it there are neither Studio tasks nor a brain. */
async function studioSession(config: RunnerConfig | null): Promise<StudioSession | null> {
  let studio: StudioConfig | undefined = config?.tracker === "studio" ? config.studio : undefined;
  if (!studio) {
    const aside = await loadRunnerConfig(STUDIO_CONFIG_PATH).catch(() => null);
    studio = aside?.tracker === "studio" ? aside.studio : undefined;
  }
  const saved = studio ? await loadSession(STUDIO_SESSION_PATH) : null;
  return studio && saved ? new StudioSession(studio, saved, fetch, Date.now, (s) => saveSession(STUDIO_SESSION_PATH, s)) : null;
}

function githubToken(): string | null {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  // launchd does not inherit the shell's PATH.
  for (const gh of ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"]) {
    try {
      return execFileSync(gh, ["auth", "token"], { encoding: "utf-8" }).trim();
    } catch {
      continue;
    }
  }
  return null;
}

/** Studio: the Mac picks up tasks from the Focus app; GitHub, when signed in, still hosts the code (pull requests, diffs). */
function trackerFor(config: RunnerConfig, session: StudioSession | null): { tracker: IssueTracker; allowedAuthors: string[]; heartbeat?: () => Promise<void> } {
  const token = githubToken();
  if (config.tracker === "github") {
    if (!token) throw new Error("No GitHub token: set GITHUB_TOKEN or run `gh auth login`.");
    return { tracker: new GitHubIssueTracker(token), allowedAuthors: config.allowedAuthors };
  }
  if (!session) throw new Error(`This Mac is not paired with Studio: run \`npm run pair -- <code> "<Mac name>"\` (${STUDIO_SESSION_PATH}).`);
  const studio = new StudioIssueTracker(session, token ? new GitHubIssueTracker(token) : undefined);
  return { tracker: studio, allowedAuthors: [session.uid], heartbeat: () => studio.heartbeat() };
}

async function main(): Promise<void> {
  const config = await loadRunnerConfig(CONFIG_PATH);
  const session = await studioSession(config);
  const brain = session && process.env.AITASKER_BRAIN !== "off" ? new StudioBrain(session, undefined, fetch, (line) => console.log(line)) : null;
  console.log(brain ? "Studio instructions and reviews: on" : "Studio instructions and reviews: off (not paired); tasks run as written, without UX or code review");

  const link = config ? trackerFor(config, session) : null;
  const loop = config && link
    ? new IssueLoop({
        tracker: link.tracker,
        compute: new FetchComputeAgentClient(COMPUTE_BASE_URL),
        store: new JsonFileTrackedTaskRepository(TASKS_PATH),
        config: { label: config.label, repos: config.repos, allowedAuthors: link.allowedAuthors, callbackBaseUrl: CALLBACK_BASE_URL },
        fetchImage: async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer()),
        brain: brain ?? undefined,
        misses: new JsonlReviewerMisses(MISSES_PATH),
      })
    : undefined;

  createApp({ issueJobs: loop }).listen(PORT, HOST, () => {
    console.log(`Runner listening on ${HOST}:${PORT}`);
    console.log(config
      ? `Polling ${config.tracker === "studio" ? "Studio tasks" : `issues labelled "${config.label}"`} every ${POLL_MS / 1000} s: ${Object.keys(config.repos).join(", ")}`
      : `No ${CONFIG_PATH}: polling disabled`);
  });

  if (loop) {
    let busy = false;
    const poll = async () => {
      if (busy) return; // never two passes at once
      busy = true;
      try {
        await link?.heartbeat?.();
        await loop.tick();
      } catch (err) {
        console.error("Polling failed:", err);
      } finally {
        busy = false;
      }
    };
    setInterval(poll, POLL_MS);
    void poll();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
