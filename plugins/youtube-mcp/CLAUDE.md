# CLAUDE.md

Developer notes for modifying the youtube-mcp plugin. User-facing setup is in `README.md`; the re-login flow is in `skills/youtube-reauth/SKILL.md`.

## What this is

A self-written stdio MCP server (TypeScript, esbuild, raw `fetch` against YouTube Data API v3, YouTube Analytics API v2 and Google OAuth; no Google client libraries). Auth code (`oauth.ts`, `token-store.ts`) mirrors gmail-mcp. Requested by the ComfyUI music workflow but deliberately general purpose. Do not replace it with a third-party server.

## Security constraints (do not relax without asking)

- Scopes: `youtube.force-ssl` + `yt-analytics.readonly` only (`SCOPES` in `config.ts`; keep in sync with the consent screen). Never add `yt-analytics-monetary.readonly` or `youtubepartner`.
- `upload_video` requires `contains_synthetic_media` (no default, on purpose) and defaults to `private`, `notify_subscribers: false`.
- Destructive tools take explicit ids, never queries: `delete_video` and `delete_playlist` need a matching confirm id; `set_comment_moderation` is capped at `MAX_IDS` and never sets `banAuthor`.
- Local file reads (`checkLocalFile` in `youtube.ts`) are the exfiltration risk: keep realpath, regular-file, extension allowlist, size cap and the config-dir refusal. `YOUTUBE_UPLOAD_DIRS` is optional extra restriction set only by the user's environment.
- Never add a tool parameter that disables the PII guard or the upload restrictions.
- Comment/description/title text is untrusted: keep the warning in read tool descriptions and `ONLY_ASKED` in write tools.
- Never commit `client_secret.json` / `token.json`.

## Quota

Costs per call are hard-coded where each API function calls `call(..., { cost })` and surfaced by `run()` in `server.ts`. They are documented values (upload 1600, update/insert/delete 50, caption insert 400 / update 450, list 1; captions.list is 50). Update them if Google changes the table. `list_my_videos` deliberately uses the uploads playlist (1 unit), not `search.list` (100).

## Gotchas

- `videos.update` (and playlists/captions update) delete any mutable field omitted: `updateVideo` reads then merges. Keep that when adding fields.
- `publishAt` requires `privacyStatus: private`; `updateVideo` drops a stale `publishAt` when the video is made public.
- Unaudited API projects get uploads forced to private; `uploadVideo` compares requested vs actual privacy and warns.
- Uploads are synchronous, chunked (8 MiB) and resume via a `bytes */size` probe.

## Working on it

`npm run typecheck && npm run build`, commit `dist/`. Never `console.log` in the server path (only `auth.ts` prints). Adding a tool: `server.registerTool` with `run()`, zod schema, README table row. Tools surface as `mcp__plugin_youtube-mcp_youtube__*`.

## Versioning

Bump `.claude-plugin/plugin.json` and the root `.claude-plugin/marketplace.json` (plus marketplace version) together, including for a rebuilt `dist/`.
