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
| `mark_read` / `mark_unread` | Toggle the unread state |
| `archive` / `unarchive` | Remove from / return to the inbox |
| `star` / `unstar` | Toggle the star |
| `report_spam` / `not_spam` | Move to Spam (and out of the inbox) / back to the inbox |
| `trash` / `untrash` | Move to Trash (recoverable for 30 days) / restore. **No permanent delete** |
| `modify_labels` | Add or remove labels by id (`SPAM`, `TRASH`, `DRAFT`, `SENT` are refused) |
| `create_label` / `delete_label` | Manage labels (deleting a label keeps the messages) |

The mailbox-changing tools take explicit `ids` (thread ids by default, or message ids with `target: "message"`), at most 25 per call, and never a search query. `trash`, `report_spam` and `delete_label` are marked destructive so Claude Code asks before running them (unless you have allowlisted them: allowlist the safe ones individually rather than `mcp__plugin_gmail-mcp_gmail__*`).

## PII guard

Email content is masked **before it reaches the model**. Cards (Luhn-checked), US SSN, Taiwan national ID, IBAN, API keys and tokens, private keys, password values and one-time codes become placeholders like `[REDACTED:CARD]`. Ids and the `from`/`to`/`cc`/`date` headers are left intact, and a `PII guard masked: CARDx1` line tells you when it fired. `create_draft` refuses to save a draft that contains any of these.

Set `GMAIL_PII_MODE` in the environment that launches Claude Code:

| Value | Effect |
|---|---|
| `mask` (default) | The detectors above |
| `strict` | Also masks email addresses and phone numbers in bodies and subjects |
| `off` | Disabled |

It is best-effort pattern matching: it does not find names or free-text addresses, and it is not a compliance control.

The only scope is `gmail.modify`. There is deliberately no send tool and no permanent delete, and write tools are limited to a few explicit ids per call, which limits the damage a prompt-injected email can do. Email bodies are untrusted input.

**Upgrading from 0.4.x or earlier:** add the `gmail.modify` scope to the OAuth consent screen and sign in again (`node dist/auth.js`); until then write tools answer "Insufficient permissions".

## Setup

Requires only `node` (the server is a committed, bundled `dist/`). Each user needs their own Google Cloud project:

1. Create a GCP project and enable **Gmail API** (`gmail.googleapis.com`).
2. Configure the OAuth consent screen: user type **External**, publishing status **Testing**. Add yourself as a **test user** and add the `gmail.modify` scope (Gmail API). Do not click "Publish app".
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
