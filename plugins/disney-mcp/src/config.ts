import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const override = process.env.DISNEY_MCP_DIR;
export const CONFIG_DIR = override
  ? override.replace(/^~(?=$|\/)/, homedir())
  : join(homedir(), ".config", "disney-mcp");
// A TMDB v3 API key or v4 read access token; TMDB_API_KEY takes precedence.
export const API_KEY_PATH = join(CONFIG_DIR, "tmdb_key");

// In the esbuild bundle import.meta.url is dist/server.js, so this resolves to dist/auth.js.
export const AUTH_HINT = `node ${fileURLToPath(new URL("./auth.js", import.meta.url))}`;
