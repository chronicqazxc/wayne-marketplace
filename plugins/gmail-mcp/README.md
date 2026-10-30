# gmail-mcp

Self-hosted, self-written Gmail MCP server (Python, stdio) using the **official Gmail API**. No third-party service; your token lives only in `~/.config/gmail-mcp/token.json` (mode 0600).

## Tools

| Tool | Description |
|---|---|
| `search_threads` | Search threads with Gmail syntax (`from:bob is:unread newer_than:7d`) |
| `get_thread` | Read every message in a thread |
| `get_message` | Read a single message |
| `list_labels` | List labels |
| `list_drafts` | List drafts |
| `create_draft` | Create a draft (optionally as a reply via `thread_id`). **Never sends** |

Scopes are only `gmail.readonly` and `gmail.compose`. There is deliberately no send, delete or label-modify tool, which limits the damage a prompt-injected email can do. Email bodies are untrusted input.

## Setup

Requires [uv](https://docs.astral.sh/uv/) and Python >= 3.11. Each user needs their own Google Cloud project:

1. Create a GCP project and enable **Gmail API** (`gmail.googleapis.com`).
2. Configure the OAuth consent screen: user type **External**, publishing status **Testing**. Add yourself as a **test user** and add the two scopes above. Do not click "Publish app".
3. Create an OAuth client of type **Desktop app** (a Web client does not work) and save its JSON as `~/.config/gmail-mcp/client_secret.json`.
4. Sign in once:
   ```shell
   cd plugins/gmail-mcp && uv run server.py auth
   ```
   In the consent flow click **Advanced** > **Go to app (unsafe)** and tick all permission checkboxes. Back/Cancel gives `access_denied`.
5. Install the plugin; Claude Code starts the server via `.mcp.json`.

In Testing mode the refresh token expires every 7 days. When tools report "Not authenticated" or "Token expired", run the `gmail-reauth` skill (or `uv run server.py auth`).

If you previously registered a user-scope `gmail` server, remove it to avoid a duplicate: `claude mcp remove gmail --scope user`.

## Development

Dependencies are in `pyproject.toml` / `uv.lock`; `uv run` creates `.venv/` on demand (git-ignored). Env: `GMAIL_MCP_DIR` overrides the config dir (default `~/.config/gmail-mcp`).
