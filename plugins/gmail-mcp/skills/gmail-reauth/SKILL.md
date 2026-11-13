---
name: gmail-reauth
description: Re-authenticate the Gmail MCP when its OAuth token has expired or is missing (errors like "Not authenticated", "Token expired" or "Insufficient permissions" from gmail tools). Use when the user asks to refresh, renew or log in to Gmail.
---

# Renew the Gmail token

While the Google OAuth consent screen is in **Testing** mode, the refresh token expires every 7 days. The login needs a browser, so Claude must not run it: ask the user to run it.

1. Confirm the failure is an auth error ("Not authenticated", "Token expired" or "Insufficient permissions", the last meaning the saved login predates the `gmail.modify` scope) from a `gmail` tool. Other errors are not fixed by reauth.
2. Tell the user to run this themselves (the `!` prefix runs it in the session):
   ```shell
   ! node "${CLAUDE_PLUGIN_ROOT}/dist/auth.js"
   ```
   A browser window opens and listens on a localhost callback. The output ends with `Token saved to ~/.config/gmail-mcp/token.json`.
3. After they confirm, retry the original tool call. The server reads the token file on every call, so no restart is needed.

## Troubleshooting
- **"Missing OAuth client file"**: `~/.config/gmail-mcp/client_secret.json` is absent. Follow the setup steps in the plugin README to create a **Desktop app** OAuth client and save its JSON there.
- **"Google hasn't verified this app"**: click **Advanced** > **Go to app (unsafe)**, which is expected for a personal app in Testing mode.
- **access_denied**: the user clicked Back/Cancel, or left a permission checkbox unticked. Rerun and tick every checkbox. An Incognito window signed in to the right account can help.
- Never ask the user to paste the contents of `client_secret.json` or `token.json` into chat.
