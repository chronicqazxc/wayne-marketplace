import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

export async function saveToken(token: StoredToken): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  // Write-then-rename so a concurrent reader never sees a half-written file.
  const tmp = `${TOKEN_PATH}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(token, null, 2), { mode: 0o600 });
  await rename(tmp, TOKEN_PATH);
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

/** Returns a valid access token, refreshing and re-saving it when expired. */
export async function getAccessToken(): Promise<string> {
  const t = await loadToken();
  const expiresAt = t.expiry ? Date.parse(t.expiry) : Infinity;
  if (t.token && Date.now() < expiresAt - EXPIRY_SKEW_MS) return t.token;

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
