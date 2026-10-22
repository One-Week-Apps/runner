import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Where to reach Firebase: Google's endpoints in production, the emulators in development. */
export interface StudioConfig {
  projectId: string;
  apiKey: string;
  bucket: string;
  /** URL of the `pairRunnerWithCode` function. */
  pairUrl: string;
  emulators?: { auth: string; firestore: string; storage: string };
}

/** What the Mac keeps after pairing (~/.aitasker/studio-session.json, readable by its owner only). */
export interface SavedSession {
  uid: string;
  runnerId: string;
  refreshToken: string;
}

export class StudioAuthError extends Error {}

export function endpoints(config: StudioConfig) {
  const e = config.emulators;
  return {
    signIn: `${e ? `${e.auth}/` : "https://"}identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${config.apiKey}`,
    refresh: `${e ? `${e.auth}/` : "https://"}securetoken.googleapis.com/v1/token?key=${config.apiKey}`,
    documents: `${e?.firestore ?? "https://firestore.googleapis.com"}/v1/projects/${config.projectId}/databases/(default)/documents`,
    storage: `${e?.storage ?? "https://firebasestorage.googleapis.com"}/v0/b/${config.bucket}/o`,
  };
}

/** The Mac's ID token, renewed before it expires from the refresh token kept on disk. */
export class StudioSession {
  private idToken: string | null = null;
  private expiresAt = 0;

  constructor(
    readonly config: StudioConfig,
    private saved: SavedSession,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly persist: (session: SavedSession) => Promise<void> = async () => {},
  ) {}

  get uid(): string { return this.saved.uid; }
  get runnerId(): string { return this.saved.runnerId; }

  async token(): Promise<string> {
    if (this.idToken && this.now() < this.expiresAt - 60_000) return this.idToken;
    const res = await this.fetchImpl(endpoints(this.config).refresh, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: this.saved.refreshToken }).toString(),
    });
    if (!res.ok) throw new StudioAuthError(`This Mac is no longer paired (${res.status}): run \`npm run pair\` again.`);
    const data = (await res.json()) as { id_token: string; refresh_token: string; expires_in: string };
    this.idToken = data.id_token;
    this.expiresAt = this.now() + Number(data.expires_in) * 1000;
    if (data.refresh_token !== this.saved.refreshToken) {
      this.saved = { ...this.saved, refreshToken: data.refresh_token };
      await this.persist(this.saved);
    }
    return this.idToken;
  }

  /** Pairing: the code typed on the Mac is exchanged for a custom token, then for a long-lived session. Messages are for the developer, in French. */
  static async pair(config: StudioConfig, code: string, name: string, fetchImpl: typeof fetch = fetch): Promise<SavedSession> {
    const paired = await fetchImpl(config.pairUrl, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, name }),
    });
    if (!paired.ok) {
      const reason = ((await paired.json().catch(() => ({}))) as { error?: string }).error ?? String(paired.status);
      const why: Record<string, string> = {
        invalid_code: "code inconnu ou expiré : demande-en un nouveau dans Focus",
        invalid_request: "le code fait 6 chiffres",
        too_many_attempts: "trop d'essais, réessaie dans une minute",
        too_many_macs: "ton offre Studio compte déjà tous ses Macs : retire-en un dans Focus, ou passe à Studio Pro (3 Macs)",
      };
      throw new StudioAuthError(`Appairage refusé : ${why[reason] ?? reason}.`);
    }
    const { uid, runnerId, customToken } = (await paired.json()) as { uid: string; runnerId: string; customToken: string };
    const signed = await fetchImpl(endpoints(config).signIn, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    });
    if (!signed.ok) throw new StudioAuthError(`Connexion du Mac refusée (${signed.status}).`);
    const { refreshToken } = (await signed.json()) as { refreshToken: string };
    return { uid, runnerId, refreshToken };
  }
}

export async function loadSession(path: string): Promise<SavedSession | null> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as SavedSession;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function saveSession(path: string, session: SavedSession): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(session, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
}
