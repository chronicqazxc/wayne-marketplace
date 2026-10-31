import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { API_KEY_PATH, CONFIG_DIR } from "./config.js";
import { verifyCredential } from "./tmdb.js";

// Reads a secret without echoing it. Falls back to plain stdin when there is no TTY (piped input).
function readSecret(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      let data = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (c) => (data += c));
      stdin.on("end", () => resolve(data.trim()));
      stdin.on("error", reject);
      return;
    }
    process.stdout.write(prompt);
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\u0003") {
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
        } else if (ch === "\u007f") {
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
  if (!(await verifyCredential(key))) throw new Error("TMDB rejected that key. Check you copied the whole value.");
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(API_KEY_PATH, key, { mode: 0o600 });
  chmodSync(API_KEY_PATH, 0o600); // writeFileSync's mode is ignored when the file already exists
  console.log(`Key verified and saved to ${API_KEY_PATH}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
