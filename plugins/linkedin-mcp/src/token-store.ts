import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { CONFIG_DIR, TOKEN_PATH } from "./config.js";

export interface StoredToken {
  accessToken: string;
  expiresAt: number; // epoch ms
  scope: string;
  sub: string; // LinkedIn member id, used to build urn:li:person:<sub>
  name?: string;
}

export async function saveToken(token: StoredToken): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(TOKEN_PATH, JSON.stringify(token, null, 2), { mode: 0o600 });
  await chmod(TOKEN_PATH, 0o600);
}

export async function loadToken(): Promise<StoredToken> {
  let raw: string;
  try {
    raw = await readFile(TOKEN_PATH, "utf8");
  } catch {
    throw new Error("Not authenticated. Run `npm run auth` in the linkedin-mcp plugin directory.");
  }
  const token = JSON.parse(raw) as StoredToken;
  if (Date.now() >= token.expiresAt) {
    throw new Error("LinkedIn access token expired. Re-run `npm run auth`.");
  }
  return token;
}
