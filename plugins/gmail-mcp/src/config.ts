import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const override = process.env.GMAIL_MCP_DIR;
export const CONFIG_DIR = override
  ? override.replace(/^~(?=$|\/)/, homedir())
  : join(homedir(), ".config", "gmail-mcp");
export const CLIENT_PATH = join(CONFIG_DIR, "client_secret.json");
export const TOKEN_PATH = join(CONFIG_DIR, "token.json");

// gmail.modify = read, drafts, and label changes (read/unread, archive, spam, trash, star, labels).
// It cannot send mail or permanently delete: do NOT add mail.google.com/ or gmail.send.
export const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];

// In the esbuild bundle import.meta.url is dist/server.js, so this resolves to dist/auth.js.
export const AUTH_HINT = `node ${fileURLToPath(new URL("./auth.js", import.meta.url))}`;
