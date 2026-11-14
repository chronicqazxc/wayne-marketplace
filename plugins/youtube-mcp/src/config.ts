import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const expand = (p: string) => p.replace(/^~(?=$|\/)/, homedir());

const override = process.env.YOUTUBE_MCP_DIR;
export const CONFIG_DIR = override ? expand(override) : join(homedir(), ".config", "youtube-mcp");
export const CLIENT_PATH = join(CONFIG_DIR, "client_secret.json");
export const TOKEN_PATH = join(CONFIG_DIR, "token.json");

// youtube.force-ssl = manage videos, playlists, captions, comments, thumbnails (it also covers uploads).
// yt-analytics.readonly = channel analytics, no revenue data. Do NOT add yt-analytics-monetary.readonly
// or youtubepartner: nothing here needs them.
export const SCOPES = [
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];

// Optional allowlist of folders that uploads may read from (YOUTUBE_UPLOAD_DIRS, ':'-separated).
// Unset = any folder, but file type/size checks still apply and the config dir is always refused.
export const UPLOAD_DIRS = (process.env.YOUTUBE_UPLOAD_DIRS ?? "")
  .split(delimiter)
  .map((d) => d.trim())
  .filter(Boolean)
  .map((d) => resolve(expand(d)));

// In the esbuild bundle import.meta.url is dist/server.js, so this resolves to dist/auth.js.
export const AUTH_HINT = `node ${fileURLToPath(new URL("./auth.js", import.meta.url))}`;
