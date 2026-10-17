---
name: linkedin-reauth
description: Re-authenticate the LinkedIn MCP when its OAuth token has expired or is missing (errors like "Not authenticated" or "access token expired" from linkedin_* tools). Use when the user asks to refresh, renew or log in to LinkedIn.
---

# Renew the LinkedIn token

The token lasts 60 days and cannot be refreshed silently. The user must click **Allow** in the browser, so tell them to expect it.

1. Run `linkedin_auth_status` to confirm the token is expired or missing. If it is valid, say so and stop unless the user insists.
2. Tell the user a browser window will open and they must approve it. Then run the login, which listens on `127.0.0.1:8765` for up to 5 minutes:
   ```shell
   node "${CLAUDE_PLUGIN_ROOT}/dist/auth.js"
   ```
   Use a Bash timeout of 330000 ms. Client credentials are read from env vars or the macOS Keychain by the script itself. Never ask the user to paste the Client ID or Secret into chat, and never print them.
3. On success the output reads `Authenticated as <name>`. Run `linkedin_auth_status` again to confirm the new expiry date and report it.

## Troubleshooting
- **"client credentials not found"**: the user must store them once in Keychain (they are prompted for the value, so it stays out of shell history):
  ```shell
  security add-generic-password -a "$USER" -s linkedin-mcp-client-id -w
  security add-generic-password -a "$USER" -s linkedin-mcp-client-secret -w
  ```
  Give them these commands to run themselves, via the `!` prefix if they want output in the session.
- **redirect_uri mismatch**: the app's Auth tab must list `http://localhost:8765/callback` exactly.
- **EADDRINUSE**: port 8765 is busy; stop the other process or set `LINKEDIN_CALLBACK_PORT` and update the redirect URL to match.
- **Timed out**: the user did not approve in 5 minutes; rerun.
- The MCP server reads the token file on every call, so no restart is needed after renewing.
