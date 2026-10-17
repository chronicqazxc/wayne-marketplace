import{createRequire}from'module';const require=createRequire(import.meta.url);

// src/oauth.ts
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

// src/config.ts
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
var CONFIG_DIR = process.env.LINKEDIN_MCP_HOME ?? join(homedir(), ".config", "linkedin-mcp");
var TOKEN_PATH = join(CONFIG_DIR, "token.json");
var SCOPES = ["openid", "profile", "email", "w_member_social"];
var CALLBACK_PORT = Number(process.env.LINKEDIN_CALLBACK_PORT ?? 8765);
var REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;
var API_VERSION = process.env.LINKEDIN_API_VERSION ?? "202609";
function fromKeychain(service) {
  if (process.platform !== "darwin") return void 0;
  try {
    return execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return void 0;
  }
}
function requireClientCredentials() {
  const clientId = process.env.LINKEDIN_CLIENT_ID ?? fromKeychain("linkedin-mcp-client-id");
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET ?? fromKeychain("linkedin-mcp-client-secret");
  if (!clientId || !clientSecret) {
    throw new Error(
      "LinkedIn client credentials not found. Set LINKEDIN_CLIENT_ID/LINKEDIN_CLIENT_SECRET, or store them in Keychain (see README)."
    );
  }
  return { clientId, clientSecret };
}

// src/token-store.ts
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
async function saveToken(token) {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 448 });
  await writeFile(TOKEN_PATH, JSON.stringify(token, null, 2), { mode: 384 });
  await chmod(TOKEN_PATH, 384);
}

// src/oauth.ts
function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).on("error", () => {
  });
}
function waitForCode(state) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", REDIRECT_URI);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const ok = !error && code && url.searchParams.get("state") === state;
      res.writeHead(ok ? 200 : 400, { "Content-Type": "text/plain" });
      res.end(ok ? "LinkedIn connected. You can close this tab." : `Login failed: ${error ?? "state mismatch"}`);
      server.close();
      ok ? resolve(code) : reject(new Error(error ?? "OAuth state mismatch"));
    });
    server.listen(CALLBACK_PORT, "127.0.0.1");
    server.on("error", reject);
    setTimeout(() => {
      server.close();
      reject(new Error("Timed out after 5 minutes waiting for LinkedIn approval."));
    }, 5 * 6e4).unref();
  });
}
async function login() {
  const { clientId, clientSecret } = requireClientCredentials();
  const state = randomBytes(16).toString("hex");
  const authUrl = new URL("https://www.linkedin.com/oauth/v2/authorization");
  authUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    state,
    scope: SCOPES.join(" ")
  }).toString();
  console.log(`Opening browser. If nothing happens, visit:
${authUrl}
`);
  const codePromise = waitForCode(state);
  openBrowser(authUrl.toString());
  const code = await codePromise;
  const tokenRes = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      client_secret: clientSecret
    })
  });
  if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  const t = await tokenRes.json();
  const info = await (await fetch("https://api.linkedin.com/v2/userinfo", { headers: { Authorization: `Bearer ${t.access_token}` } })).json();
  const stored = {
    accessToken: t.access_token,
    expiresAt: Date.now() + t.expires_in * 1e3,
    scope: t.scope,
    sub: info.sub,
    name: info.name
  };
  await saveToken(stored);
  return stored;
}

// src/auth.ts
login().then((t) => {
  console.log(`Authenticated as ${t.name ?? t.sub}. Token expires ${new Date(t.expiresAt).toISOString()}.`);
}).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
