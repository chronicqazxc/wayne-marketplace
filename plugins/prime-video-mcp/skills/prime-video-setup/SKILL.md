---
name: prime-video-setup
description: Set up or replace the TMDB API key for the Prime Video MCP (errors like "No TMDB credential" or "TMDB rejected the credential" from prime tools). Walks the user through getting a free TMDB key and saving it. Use when the user asks to set up, install or fix the Prime Video plugin.
---

# Set up the TMDB key for prime-video-mcp

The Prime Video tools read availability from TMDB, which needs a free API key. The key is a secret and the login needs a hidden prompt, so Claude must not ask for it in chat or run the script: guide the user and have them run it.

1. Confirm the failure is "No TMDB credential" or "TMDB rejected the credential" from a `prime` tool. Other errors are not fixed by this skill.
2. If the user has no key yet, walk them through it:
   1. Create a free account at https://www.themoviedb.org/signup and verify the email.
   2. Open https://www.themoviedb.org/settings/api and click **Create** (or **Request an API key**), choose **Developer**, and accept the terms.
   3. Fill the form. Personal use is fine: type "Personal", a one-line description such as "Personal Claude plugin to check where titles stream", any URL (for example their GitHub), and their own name, address and phone.
   4. Copy the **API Read Access Token** (long, starts with `eyJ`). The shorter 32-character **API Key** also works.
3. Tell the user to copy the key, then run this themselves (the `!` prefix runs it in the session, which has no terminal for a hidden prompt, so the key is piped from the clipboard; on Linux use `xclip -o` or `wl-paste` instead of `pbpaste`):
   ```shell
   ! pbpaste | node "${CLAUDE_PLUGIN_ROOT}/dist/auth.js"
   ```
   In a normal terminal window, plain `node "${CLAUDE_PLUGIN_ROOT}/dist/auth.js"` prompts with hidden input instead.
   The script checks the key with TMDB and ends with `Key verified and saved to ~/.config/prime-video-mcp/tmdb_key`.
4. After they confirm, retry the original tool call. The server reads the key file on every call, so no restart is needed.

## Troubleshooting
- **"TMDB rejected that key"**: they copied only part of it, or pasted the wrong value. Copy again from the TMDB API settings page.
- **"No key entered"**: the key was not piped in (or the clipboard is empty). Copy the key again and rerun with `pbpaste |`.
- **Hidden prompt shows nothing**: expected; the pasted key is not echoed. Press Enter to submit.
- **Prefer an env var**: `TMDB_API_KEY` in the environment takes precedence over the key file.
- Never ask the user to paste the key into chat, and never print or read `~/.config/prime-video-mcp/tmdb_key`.
