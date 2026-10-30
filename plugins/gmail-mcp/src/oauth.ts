import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { CLIENT_PATH, SCOPES } from "./config.js";
import { formatExpiry, saveToken } from "./token-store.js";

interface InstalledClient {
  client_id: string;
  client_secret: string;
  auth_uri: string;
  token_uri: string;
}

async function loadClient(): Promise<InstalledClient> {
  let raw: string;
  try {
    raw = await readFile(CLIENT_PATH, "utf8");
  } catch {
    throw new Error(`Missing OAuth client file: ${CLIENT_PATH}\nDownload the Desktop-app client JSON there.`);
  }
  const installed = (JSON.parse(raw) as { installed?: InstalledClient }).installed;
  if (!installed?.client_id || !installed.client_secret || !installed.auth_uri || !installed.token_uri) {
    throw new Error(`${CLIENT_PATH} has no "installed" section: create the OAuth client as a Desktop app, not a Web app.`);
  }
  return installed;
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).on("error", () => {});
}

// Desktop clients accept any loopback port, so let the OS pick a free one.
async function listenForCode(state: string): Promise<{ redirectUri: string; code: Promise<string> }> {
  const server = createServer();
  const code = new Promise<string>((resolve, reject) => {
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
      res.end(ok ? "Gmail connected. You can close this tab." : `Login failed: ${error ?? "state mismatch"}`);
      server.close();
      ok ? resolve(received) : reject(new Error(error ?? "OAuth state mismatch"));
    });
    server.on("error", reject);
    setTimeout(() => {
      server.close();
      reject(new Error("Timed out after 5 minutes waiting for Google approval."));
    }, 5 * 60_000).unref();
  });
  // Bind to loopback only so nothing else on the network can hit the callback.
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { redirectUri: `http://127.0.0.1:${port}/callback`, code };
}

export async function login(): Promise<void> {
  const client = await loadClient();
  const state = randomBytes(16).toString("hex");
  const verifier = randomBytes(32).toString("base64url");
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
    access_type: "offline", // ask for a refresh token
    prompt: "consent", // force it even if this account approved before
  }).toString();

  console.log(`Opening browser. If nothing happens, visit:\n${authUrl}\n`);
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
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  const t = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope: string };

  // Unticked checkboxes on the consent screen yield a token with fewer scopes.
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
    expiry: formatExpiry(Date.now() + t.expires_in * 1000),
  });
}
