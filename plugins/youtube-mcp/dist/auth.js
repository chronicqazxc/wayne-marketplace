import{createRequire}from'module';const require=createRequire(import.meta.url);

// src/config.ts
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
var expand = (p) => p.replace(/^~(?=$|\/)/, homedir());
var override = process.env.YOUTUBE_MCP_DIR;
var CONFIG_DIR = override ? expand(override) : join(homedir(), ".config", "youtube-mcp");
var CLIENT_PATH = join(CONFIG_DIR, "client_secret.json");
var TOKEN_PATH = join(CONFIG_DIR, "token.json");
var QUOTA_PATH = join(CONFIG_DIR, "quota.json");
var SCOPES = [
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/yt-analytics.readonly"
];
var UPLOAD_DIRS = (process.env.YOUTUBE_UPLOAD_DIRS ?? "").split(delimiter).map((d) => d.trim()).filter(Boolean).map((d) => resolve(expand(d)));
var AUTH_HINT = `node ${fileURLToPath(new URL("./auth.js", import.meta.url))}`;

// src/oauth.ts
import { createHash, randomBytes as randomBytes2 } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile as readFile2 } from "node:fs/promises";
import { createServer } from "node:http";

// src/token-store.ts
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
var saveChain = Promise.resolve();
function saveToken(token) {
  const run = saveChain.then(() => writeTokenFile(token));
  saveChain = run.catch(() => {
  });
  return run;
}
async function writeTokenFile(token) {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 448 });
  const tmp = `${TOKEN_PATH}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(token, null, 2), { mode: 384 });
    await rename(tmp, TOKEN_PATH);
  } catch (e) {
    await unlink(tmp).catch(() => {
    });
    const onDisk = await loadToken().catch(() => void 0);
    if (!onDisk?.token) throw e;
  }
}
async function loadToken() {
  let raw;
  try {
    raw = await readFile(TOKEN_PATH, "utf8");
  } catch {
    throw new Error(`Not authenticated. Run: ${AUTH_HINT} (${TOKEN_PATH} missing)`);
  }
  return JSON.parse(raw);
}
function formatExpiry(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// src/oauth.ts
async function loadClient() {
  let raw;
  try {
    raw = await readFile2(CLIENT_PATH, "utf8");
  } catch {
    throw new Error(`Missing OAuth client file: ${CLIENT_PATH}
Download the Desktop-app client JSON there.`);
  }
  const installed = JSON.parse(raw).installed;
  if (!installed?.client_id || !installed.client_secret || !installed.auth_uri || !installed.token_uri) {
    throw new Error(`${CLIENT_PATH} has no "installed" section: create the OAuth client as a Desktop app, not a Web app.`);
  }
  return installed;
}
function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).on("error", () => {
  });
}
async function listenForCode(state) {
  const server = createServer();
  const code = new Promise((resolve2, reject) => {
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      const received = url.searchParams.get("code");
      const ok = !error && received && url.searchParams.get("state") === state;
      res.writeHead(ok ? 200 : 400, { "Content-Type": "text/plain", Connection: "close" });
      res.end(ok ? "YouTube connected. You can close this tab." : `Login failed: ${error ?? "state mismatch"}`);
      server.close();
      ok ? resolve2(received) : reject(new Error(error ?? "OAuth state mismatch"));
    });
    server.on("error", reject);
    setTimeout(() => {
      server.close();
      reject(new Error("Timed out after 5 minutes waiting for Google approval."));
    }, 5 * 6e4).unref();
  });
  await new Promise((resolve2) => server.listen(0, "127.0.0.1", resolve2));
  const { port } = server.address();
  return { redirectUri: `http://127.0.0.1:${port}/callback`, code };
}
async function login() {
  const client = await loadClient();
  const state = randomBytes2(16).toString("hex");
  const verifier = randomBytes2(32).toString("base64url");
  const { redirectUri, code: codePromise } = await listenForCode(state);
  const authUrl = new URL(client.auth_uri);
  authUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirectUri,
    scope: SCOPES.join(" "),
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    access_type: "offline",
    // ask for a refresh token
    prompt: "select_account consent"
    // always show the account/brand-channel picker, and force a refresh token
  }).toString();
  console.log(`Opening browser. If nothing happens, visit:
${authUrl}
`);
  openBrowser(authUrl.toString());
  const code = await codePromise;
  const res = await fetch(client.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: client.client_id,
      client_secret: client.client_secret,
      code_verifier: verifier
    })
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  const t = await res.json();
  const granted = t.scope.split(" ");
  const missing = SCOPES.filter((s) => !granted.includes(s));
  if (missing.length) throw new Error(`Permissions not granted: ${missing.join(", ")}. Rerun and tick every checkbox.`);
  if (!t.refresh_token) throw new Error("Google returned no refresh token. Rerun the login.");
  await saveToken({
    token: t.access_token,
    refresh_token: t.refresh_token,
    token_uri: client.token_uri,
    client_id: client.client_id,
    client_secret: client.client_secret,
    scopes: SCOPES,
    universe_domain: "googleapis.com",
    account: "",
    expiry: formatExpiry(Date.now() + t.expires_in * 1e3),
    refresh_token_issued: formatExpiry(Date.now())
    // metadata only, lets auth_status warn before a 7-day expiry
  });
}

// src/auth.ts
login().then(() => console.log(`Token saved to ${TOKEN_PATH}`)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
