import{createRequire}from'module';const require=createRequire(import.meta.url);

// src/auth.ts
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";

// src/config.ts
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
var override = process.env.NETFLIX_MCP_DIR;
var CONFIG_DIR = override ? override.replace(/^~(?=$|\/)/, homedir()) : join(homedir(), ".config", "netflix-mcp");
var API_KEY_PATH = join(CONFIG_DIR, "tmdb_key");
var AUTH_HINT = `node ${fileURLToPath(new URL("./auth.js", import.meta.url))}`;

// src/tmdb.ts
var BASE = "https://api.themoviedb.org/3";
function authorize(url, cred) {
  const headers = { accept: "application/json" };
  if (cred.startsWith("eyJ")) headers.authorization = `Bearer ${cred}`;
  else url.searchParams.set("api_key", cred);
  return headers;
}
async function verifyCredential(cred) {
  const url = new URL(`${BASE}/authentication`);
  const res = await fetch(url, { headers: authorize(url, cred), signal: AbortSignal.timeout(15e3) });
  if (res.status === 401) return false;
  if (!res.ok) throw new Error(`TMDB check failed (${res.status}); try again later.`);
  return true;
}
var regionNames = new Intl.DisplayNames(["en"], { type: "region" });

// src/auth.ts
function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      let data = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (c) => data += c);
      stdin.on("end", () => resolve(data.trim()));
      stdin.on("error", reject);
      return;
    }
    process.stdout.write(prompt);
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "") {
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        } else if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value.trim());
          return;
        } else if (ch === "\x7F") {
          value = value.slice(0, -1);
        } else {
          value += ch;
        }
      }
    };
    stdin.on("data", onData);
  });
}
async function main() {
  console.log("Get a free key at https://www.themoviedb.org/settings/api (API Read Access Token or API Key).");
  const key = await readSecret("Paste your TMDB key (input hidden): ");
  if (!key) throw new Error("No key entered.");
  if (!await verifyCredential(key)) throw new Error("TMDB rejected that key. Check you copied the whole value.");
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 448 });
  writeFileSync(API_KEY_PATH, key, { mode: 384 });
  chmodSync(API_KEY_PATH, 384);
  console.log(`Key verified and saved to ${API_KEY_PATH}`);
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
