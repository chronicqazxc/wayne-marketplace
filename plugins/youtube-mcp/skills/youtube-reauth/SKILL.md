---
name: youtube-reauth
description: Re-authenticate the YouTube MCP when its OAuth token has expired or is missing (errors like "Not authenticated", "Token expired" or "Insufficient permissions" from youtube tools). Use when the user asks to refresh, renew or log in to YouTube.
---

# Renew the YouTube token

While the Google OAuth consent screen is in **Testing** mode, the refresh token expires every 7 days. The login needs a browser, so Claude must not run it: ask the user to run it.

1. Confirm the failure is an auth error ("Not authenticated", "Token expired" or "Insufficient permissions", the last meaning the saved login lacks a scope) from a `youtube` tool. Other errors (quota, API not enabled) are not fixed by reauth.
2. Tell the user to run this themselves (the `!` prefix runs it in the session):
   ```shell
   ! node "${CLAUDE_PLUGIN_ROOT}/dist/auth.js"
   ```
   A browser window opens and listens on a localhost callback. The output ends with `Token saved to ~/.config/youtube-mcp/token.json`.
3. After they confirm, retry the original tool call (or `auth_status`). The server reads the token file on every call, so no restart is needed.

## Troubleshooting
- **"Missing OAuth client file"**: `~/.config/youtube-mcp/client_secret.json` is absent. Follow the setup steps in the plugin README to create a **Desktop app** OAuth client and save its JSON there.
- **"Google hasn't verified this app"**: click **Advanced** > **Go to app (unsafe)**, expected for a personal app in Testing mode.
- **access_denied** or "Permissions not granted": the user clicked Back/Cancel or left a permission checkbox unticked. Rerun and tick every checkbox.
- **"API not enabled"**: enable **YouTube Data API v3** and **YouTube Analytics API** in the Google Cloud project.
- Never ask the user to paste the contents of `client_secret.json` or `token.json` into chat.
