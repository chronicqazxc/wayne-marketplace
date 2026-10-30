import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const override = process.env.GMAIL_MCP_DIR;
export const CONFIG_DIR = override
  ? override.replace(/^~(?=$|\/)/, homedir())
  : join(homedir(), ".config", "gmail-mcp");
export const CLIENT_PATH = join(CONFIG_DIR, "client_secret.json");
export const TOKEN_PATH = join(CONFIG_DIR, "token.json");

// Only read + draft: there is deliberately no send, delete or label-modify scope.
export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
];

// In the esbuild bundle import.meta.url is dist/server.js, so this resolves to dist/auth.js.
export const AUTH_HINT = `node ${fileURLToPath(new URL("./auth.js", import.meta.url))}`;
