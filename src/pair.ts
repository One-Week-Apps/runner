import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { loadRunnerConfig } from "./infrastructure/config.js";
import { StudioSession, saveSession } from "./infrastructure/studio/StudioSession.js";

/** `npm run pair -- 123456 "My Mac"`: the code shown in Focus links this Mac to the account. Messages are for the developer, in French. */
async function main(): Promise<void> {
  const [code, name = hostname()] = process.argv.slice(2);
  const configPath = process.env.AITASKER_CONFIG ?? join(homedir(), ".aitasker", "config.json");
  const sessionPath = process.env.AITASKER_STUDIO_SESSION ?? join(homedir(), ".aitasker", "studio-session.json");
  if (!code) throw new Error("Usage : npm run pair -- <code à 6 chiffres> [nom du Mac]");
  const config = await loadRunnerConfig(configPath);
  if (config?.tracker !== "studio") throw new Error(`${configPath} : "tracker": "studio" attendu, avec la section "studio".`);
  const session = await StudioSession.pair(config.studio, code, name);
  await saveSession(sessionPath, session);
  console.log(`✅ ${name} est appairé. Il apparaît dans Focus ; relance le Runner pour qu'il relève tes tâches.`);
}

main().catch((error) => {
  console.error(`❌ ${(error as Error).message}`);
  process.exit(1);
});
