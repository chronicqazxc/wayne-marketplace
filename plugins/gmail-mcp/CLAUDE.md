# CLAUDE.md

Developer notes for modifying the gmail-mcp plugin. User-facing setup lives in `README.md`; the re-login flow lives in `skills/gmail-reauth/SKILL.md`.

## What this is

A deliberately self-written local stdio MCP server (TypeScript bundled with esbuild, raw `fetch` against the Gmail REST API and Google's OAuth endpoints, no Google client libraries). It was ported from a Python version; the token file format is unchanged so existing logins survive. The official Google Gmail MCP was rejected (needs a Workspace account) and third-party servers were rejected for security. Do not replace it with a third-party server or fetch third-party code at runtime.

## Security constraints (do not relax without asking)

- Scope is only `gmail.modify` (read, drafts, label changes). Keep `SCOPES` in sync with the OAuth consent screen. Never add `gmail.send` or `https://mail.google.com/`: they would allow sending and permanent deletion.
- No send tool and no permanent delete. `create_draft` only creates drafts; `trash` moves to Trash (recoverable for 30 days). This limits the damage a prompt-injected email can do.
- Write tools (`mark_read`, `archive`, `trash`, `report_spam`, `modify_labels`, ...) take explicit ids only, capped at `MAX_IDS` (25) per call, never a search query, so a bulk action on "everything matching X" is impossible. Keep it that way.
- `trash`, `report_spam` and `delete_label` carry `destructiveHint`; `modify_labels` refuses `SPAM`/`TRASH`/`DRAFT`/`SENT` so those can't bypass the dedicated tools. Every write tool description tells the model to act only on what the user asked for.
- This write access was a deliberate decision by the user (previous versions were read + draft only). Adding anything more powerful still needs their approval.
- Tools that return email content (`get_thread`, `get_message`) must keep the "untrusted input" warning in their tool descriptions.
- Never commit `client_secret.json` or `token.json`. Ship `src/`, the committed `dist/`, `package.json`/`package-lock.json` (plus docs and skills); `node_modules` is git-ignored.

## PII guard

- Source: `shared/pii-guard/` (shared with other plugins, inlined into `dist/` by esbuild). Wired in `src/server.ts`: `run()` masks every tool result via `redactDeep`, so new tools are covered automatically. `PII_SKIP_KEYS` keeps ids and `from/to/cc/date` exact; add a key there if a new tool returns an id-like field.
- `GMAIL_PII_MODE`: `mask` (default) masks cards (Luhn), SSN, Taiwan ID, IBAN, API keys/tokens/private keys, password values and one-time codes; `strict` also masks emails and phone numbers in bodies; `off` disables. Unset or unknown means `mask`, never `off`.
- `create_draft` is blocked when the subject or body contains a `mask`-mode PII kind. The error names the kind, not the value.
- Never add a tool parameter that lets the model switch the guard off: a prompt-injected email could use it. Only the user's environment controls the mode.
- It is best-effort regex: no names or free-text addresses. Do not describe it as a compliance control.

## Credentials and auth

- Config dir: `~/.config/gmail-mcp` (override with `GMAIL_MCP_DIR`). Holds `client_secret.json` (user-supplied) and `token.json` (written by `auth`, mode 0600).
- Auth is a one-time browser flow, run by the user, never by the MCP server or by Claude: `node dist/auth.js`. Auth errors ("Not authenticated", "Token expired", "Insufficient permissions") are the trigger phrases in the `gmail-reauth` skill description; keep them in sync if the messages in `src/token-store.ts` change.
- Google Cloud requirements: Gmail API enabled, External consent screen in **Testing** mode with the user as a test user, and a **Desktop app** OAuth client (a Web client does not work). Do not suggest "Publish app".
- A token saved before 0.5.0 only has read + compose access: write tools fail with "Insufficient permissions" until the user reruns `auth.js` (and `gmail.modify` is added to the consent screen).
- In Testing mode the refresh token expires every 7 days, so weekly reauth is expected, not a bug.

## Working on it

- Layout: `src/server.ts` (tool registration), `src/gmail.ts` (REST calls), `src/format.ts` (pure body/MIME logic, no imports), `src/token-store.ts` (token refresh, google-auth-compatible `token.json`), `src/oauth.ts` + `src/auth.ts` (loopback + PKCE login).
- Build: `npm run typecheck && npm run build`, and commit `dist/`. `.mcp.json` runs `node ${CLAUDE_PLUGIN_ROOT}/dist/server.js`, so a stale `dist/` means the installed plugin runs old code.
- Never `console.log` in the server path: stdout carries the MCP protocol (only `auth.ts` may print).
- `create_draft` must keep rejecting CR/LF in header fields (`assertSingleLine` in `format.ts`): a prompt-injected email could otherwise add hidden headers such as Bcc.
- Adding a tool: `server.registerTool` with a clear description and zod schema, cap result sizes (`MAX_BODY_CHARS`, `MAX_RESULTS_CAP`), and update the tool table in `README.md`.
- Tools surface to Claude as `mcp__plugin_gmail-mcp_gmail__*`; update any permission allowlists if you rename one.

## Versioning

Follow the repo root `CLAUDE.md`: bump the version in both `.claude-plugin/plugin.json` and the root `.claude-plugin/marketplace.json` (plus the marketplace version) for any change to server behavior, tools or skills.
