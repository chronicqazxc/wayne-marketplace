import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = process.env.WORDPRESS_MCP_HOME ?? join(homedir(), ".config", "wordpress-mcp");
export const API_BASE = process.env.WORDPRESS_COM_API_BASE ?? "https://public-api.wordpress.com/rest/v1.1";

function fromFile(name: string): string | undefined {
  try {
    return readFileSync(join(CONFIG_DIR, name), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

// Env vars win; otherwise read a file in the user config dir (outside any repo).
export function getToken(): string {
  const t = process.env.WORDPRESS_COM_TOKEN?.trim() || fromFile("token");
  if (!t) {
    throw new Error(
      `WordPress.com token not found. Set WORDPRESS_COM_TOKEN, or put the token in ${join(CONFIG_DIR, "token")} (see README).`,
    );
  }
  return t;
}

// Site domain (e.g. example.wordpress.com) or numeric blog ID.
export function getSite(): string {
  const s = process.env.WORDPRESS_COM_SITE?.trim() || fromFile("site");
  if (!s) {
    throw new Error(
      `WordPress.com site not set. Set WORDPRESS_COM_SITE (domain or blog ID), or put it in ${join(CONFIG_DIR, "site")}.`,
    );
  }
  return s;
}
