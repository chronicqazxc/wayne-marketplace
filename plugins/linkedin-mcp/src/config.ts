import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR =
  process.env.LINKEDIN_MCP_HOME ?? join(homedir(), ".config", "linkedin-mcp");
export const TOKEN_PATH = join(CONFIG_DIR, "token.json");

export const SCOPES = ["openid", "profile", "email", "w_member_social"];
export const CALLBACK_PORT = Number(process.env.LINKEDIN_CALLBACK_PORT ?? 8765);
export const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;

// LinkedIn versioned APIs are supported for ~12 months, so keep this overridable.
export const API_VERSION = process.env.LINKEDIN_API_VERSION ?? "202609";

// Env vars win; on macOS fall back to Keychain so the secret never needs to be in a shell rc or chat.
function fromKeychain(service: string): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    return execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

export function requireClientCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.LINKEDIN_CLIENT_ID ?? fromKeychain("linkedin-mcp-client-id");
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET ?? fromKeychain("linkedin-mcp-client-secret");
  if (!clientId || !clientSecret) {
    throw new Error(
      "LinkedIn client credentials not found. Set LINKEDIN_CLIENT_ID/LINKEDIN_CLIENT_SECRET, or store them in " +
        "Keychain (see README).",
    );
  }
  return { clientId, clientSecret };
}
