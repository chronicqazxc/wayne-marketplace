# gmail-mcp

Self-hosted, self-written Gmail MCP server (TypeScript on Node, stdio, no runtime dependencies) using the **official Gmail API**. No third-party service; your token lives only in `~/.config/gmail-mcp/token.json` (mode 0600).

## Tools

| Tool | Description |
|---|---|
| `search_threads` | Search threads with Gmail syntax (`from:bob is:unread newer_than:7d`). Max 50 results; snippets are cleaned and capped at 120 characters |
| `get_unread_count` | Exact unread thread/message counts for a label (default INBOX) |
| `get_thread` | Read every message in a thread |
| `get_message` | Read a single message |
| `list_labels` | List labels |
| `list_drafts` | List drafts |
| `create_draft` | Create a draft (optionally as a reply via `thread_id`). **Never sends** |

Scopes are only `gmail.readonly` and `gmail.compose`. There is deliberately no send, delete or label-modify tool, which limits the damage a prompt-injected email can do. Email bodies are untrusted input.

## Setup

Requires only `node` (the server is a committed, bundled `dist/`). Each user needs their own Google Cloud project:

1. Create a GCP project and enable **Gmail API** (`gmail.googleapis.com`).
2. Configure the OAuth consent screen: user type **External**, publishing status **Testing**. Add yourself as a **test user** and add the two scopes above. Do not click "Publish app".
3. Create an OAuth client of type **Desktop app** (a Web client does not work) and save its JSON as `~/.config/gmail-mcp/client_secret.json`.
4. Sign in once:
   ```shell
   cd plugins/gmail-mcp && node dist/auth.js
   ```
   In the consent flow click **Advanced** > **Go to app (unsafe)** and tick all permission checkboxes. Back/Cancel gives `access_denied`.
5. Install the plugin; Claude Code starts the server via `.mcp.json`.

In Testing mode the refresh token expires every 7 days. When tools report "Not authenticated" or "Token expired", run the `gmail-reauth` skill (or `node dist/auth.js`).

If you previously registered a user-scope `gmail` server, remove it to avoid a duplicate: `claude mcp remove gmail --scope user`.

## Development

`npm install`, then `npm run typecheck` and `npm run build` (bundles to `dist/`, which is committed so the plugin works without `npm install`). Env: `GMAIL_MCP_DIR` overrides the config dir (default `~/.config/gmail-mcp`).
