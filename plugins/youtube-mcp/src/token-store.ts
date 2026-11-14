import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { AUTH_HINT, CONFIG_DIR, TOKEN_PATH } from "./config.js";

// google-auth compatible token.json (same shape as gmail-mcp). Unknown fields are preserved on save.
export interface StoredToken {
  token: string;
  refresh_token?: string;
  token_uri: string;
  client_id: string;
  client_secret: string;
  scopes: string[];
  expiry?: string; // UTC, e.g. 2026-10-30T18:18:51Z
  [extra: string]: unknown;
}

const EXPIRY_SKEW_MS = 60_000;

// Saves are chained: parallel tool calls in one process must not interleave write + rename.
let saveChain: Promise<void> = Promise.resolve();

export function saveToken(token: StoredToken): Promise<void> {
  const run = saveChain.then(() => writeTokenFile(token));
  saveChain = run.catch(() => {});
  return run;
}

async function writeTokenFile(token: StoredToken): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  // Write-then-rename so a concurrent reader never sees a half-written file. The temp name is unique per
  // save (a bare pid collides when several calls in one process save at once, and the loser's rename ENOENTs).
  const tmp = `${TOKEN_PATH}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(token, null, 2), { mode: 0o600 });
    await rename(tmp, TOKEN_PATH);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    // Another process may have refreshed and replaced the file meanwhile. If a readable token is on disk,
    // our access token is still valid for this call, so do not fail it.
    const onDisk = await loadToken().catch(() => undefined);
    if (!onDisk?.token) throw e;
  }
}

async function loadToken(): Promise<StoredToken> {
  let raw: string;
  try {
    raw = await readFile(TOKEN_PATH, "utf8");
  } catch {
    throw new Error(`Not authenticated. Run: ${AUTH_HINT} (${TOKEN_PATH} missing)`);
  }
  return JSON.parse(raw) as StoredToken;
}

export function formatExpiry(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Scopes the saved login was granted (never the token itself). */
export async function getStoredScopes(): Promise<string[]> {
  return (await loadToken()).scopes ?? [];
}

const isFresh = (t: StoredToken) => !!t.token && Date.now() < (t.expiry ? Date.parse(t.expiry) : Infinity) - EXPIRY_SKEW_MS;

let refreshing: Promise<string> | undefined;

/** Returns a valid access token, refreshing and re-saving it when expired. Concurrent callers share one refresh. */
export async function getAccessToken(): Promise<string> {
  const t = await loadToken();
  if (isFresh(t)) return t.token;
  refreshing ??= refresh().finally(() => {
    refreshing = undefined;
  });
  return refreshing;
}

async function refresh(): Promise<string> {
  const t = await loadToken(); // another process may have refreshed since the caller looked
  if (isFresh(t)) return t.token;
  if (!t.refresh_token) throw new Error(`Token expired. Run: ${AUTH_HINT}`);
  const res = await fetch(t.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
      client_id: t.client_id,
      client_secret: t.client_secret,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    // invalid_grant = refresh token revoked or expired (7 days in Testing mode).
    if (body.includes("invalid_grant")) throw new Error(`Token expired. Run: ${AUTH_HINT}`);
    throw new Error(`Token refresh failed: ${res.status} ${body}`);
  }
  const r = (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string };
  const updated: StoredToken = {
    ...t,
    token: r.access_token,
    expiry: formatExpiry(Date.now() + r.expires_in * 1000),
    ...(r.refresh_token ? { refresh_token: r.refresh_token } : {}),
  };
  await saveToken(updated);
  return updated.token;
}

/** Login/expiry metadata for auth_status. Never returns the tokens themselves. */
export async function getTokenInfo() {
  const t = await loadToken();
  const issued = typeof t.refresh_token_issued === "string" ? t.refresh_token_issued : undefined;
  return {
    access_token_expires_at: t.expiry,
    refresh_token_issued_at: issued ?? "unknown (recorded at the next login)",
    refresh_token_estimated_expiry: issued
      ? formatExpiry(Date.parse(issued) + 7 * 86_400_000)
      : "unknown (recorded at the next login)",
    refresh_token_note:
      "The estimate assumes the Google OAuth app is in Testing mode (refresh tokens last 7 days). In Production mode they do not expire on a timer. Google can also revoke them at any time.",
  };
}
