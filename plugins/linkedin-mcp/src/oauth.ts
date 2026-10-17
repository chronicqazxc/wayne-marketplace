import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { CALLBACK_PORT, REDIRECT_URI, SCOPES, requireClientCredentials } from "./config.js";
import { saveToken, type StoredToken } from "./token-store.js";

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).on("error", () => {});
}

function waitForCode(state: string): Promise<string> {
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
    // Bind to loopback only so nothing else on the network can hit the callback.
    server.listen(CALLBACK_PORT, "127.0.0.1");
    server.on("error", reject);
    setTimeout(() => {
      server.close();
      reject(new Error("Timed out after 5 minutes waiting for LinkedIn approval."));
    }, 5 * 60_000).unref();
  });
}

export async function login(): Promise<StoredToken> {
  const { clientId, clientSecret } = requireClientCredentials();
  const state = randomBytes(16).toString("hex");
  const authUrl = new URL("https://www.linkedin.com/oauth/v2/authorization");
  authUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    state,
    scope: SCOPES.join(" "),
  }).toString();

  console.log(`Opening browser. If nothing happens, visit:\n${authUrl}\n`);
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
      client_secret: clientSecret,
    }),
  });
  if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  const t = (await tokenRes.json()) as { access_token: string; expires_in: number; scope: string };

  const info = (await (
    await fetch("https://api.linkedin.com/v2/userinfo", { headers: { Authorization: `Bearer ${t.access_token}` } })
  ).json()) as { sub: string; name?: string };

  const stored: StoredToken = {
    accessToken: t.access_token,
    expiresAt: Date.now() + t.expires_in * 1000,
    scope: t.scope,
    sub: info.sub,
    name: info.name,
  };
  await saveToken(stored);
  return stored;
}
