# linkedin-mcp

Self-hosted LinkedIn MCP server using the **official LinkedIn API**. No third-party service, no scraping; your token lives only in `~/.config/linkedin-mcp/token.json` (mode 0600).

## Tools

| Tool | Description |
|---|---|
| `linkedin_get_profile` | Your name, email, picture (OpenID `/v2/userinfo`) |
| `linkedin_auth_status` | Token validity and expiry |
| `linkedin_create_post` | Publish a text post (optional article link) |
| `linkedin_edit_post` | Replace the text of your own post (commentary only) |
| `linkedin_delete_post` | Delete one of your posts by URN |

Not possible with the official API for personal apps: people/job search, messaging, reading posts (`r_member_social` is partner-only).

## Setup

1. Create an app at https://www.linkedin.com/developers/apps (needs a Company Page to associate).
2. Under **Products**, add **Sign In with LinkedIn using OpenID Connect** and **Share on LinkedIn**.
3. Under **Auth**, add redirect URL `http://localhost:8765/callback`.
4. Export credentials (e.g. in `~/.zshrc`) and log in:
   ```shell
   export LINKEDIN_CLIENT_ID=...
   export LINKEDIN_CLIENT_SECRET=...
   cd plugins/linkedin-mcp && npm install && npm run auth
   ```
5. Install the plugin; Claude Code starts the server via `.mcp.json`.

The token lasts 60 days and has no refresh token. When it expires, run the `linkedin-reauth` skill (or `npm run auth`).

### Store credentials in macOS Keychain (optional)

`auth` falls back to Keychain when the env vars are unset. You are prompted for each value, so nothing lands in shell history:

```shell
security add-generic-password -a "$USER" -s linkedin-mcp-client-id -w
security add-generic-password -a "$USER" -s linkedin-mcp-client-secret -w
```

## Development

`npm run typecheck`, then `npm run build` (bundles to `dist/`, which is committed so the plugin works without `npm install`).

Env: `LINKEDIN_API_VERSION` (default `202609`), `LINKEDIN_CALLBACK_PORT` (default `8765`), `LINKEDIN_MCP_HOME`.
