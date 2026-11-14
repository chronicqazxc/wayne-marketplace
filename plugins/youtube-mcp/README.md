# youtube-mcp

Self-hosted, self-written YouTube MCP server (TypeScript on Node, stdio) using the **official YouTube Data API v3 and YouTube Analytics API**. General purpose: any workflow can publish and manage YouTube content. No third-party service; the login lives only in `~/.config/youtube-mcp/token.json` (mode 0600).

## Tools

| Tool | Description | Quota |
|---|---|---|
| `auth_status` | Connected channel, granted scopes, upload folder allowlist, login issue/estimated expiry date, today's quota estimate | 1 |
| `quota_status` | Persisted per-Pacific-day quota estimate: spent, remaining, uploads that still fit | 0 |
| `list_categories` | Assignable category ids for a region | 1 |
| `upload_video` | Upload a local video (resumable, 8 MiB chunks) with title, description, tags, category, privacy or scheduled `publish_at`, thumbnail and the **required** `contains_synthetic_media` AI-content flag. Defaults to private. Optional `playlist_id`/`playlist_title` (adds the video right after upload) and `upload_filename` | 1,600 (+50 playlist) |
| `upload_videos` | Batch of up to 10 uploads; validates everything first, stops when the daily quota estimate can't cover the next one or on the first failure | 1,600 each |
| `update_video` | Edit metadata, visibility, schedule, AI flag. Only passed fields change | 51 |
| `get_video` / `list_my_videos` | Read one video (AI flag, rejection/processing status, stored file name, region/licensed-content info) / page through your uploads (incl. private, `privacy` filter, `all_pages`) | 1-3 |
| `set_thumbnail` | Custom thumbnail (jpg/png, 2 MB) | 50 |
| `delete_video` | Permanent delete; needs `confirm_video_id` | 51 |
| `list_playlists` `create_playlist` `update_playlist` `delete_playlist` | Manage playlists (`delete_playlist` needs a confirm id) | 1-51 |
| `list_playlist_items` `add_to_playlist` `remove_from_playlist` | Manage playlist entries | 1-50 |
| `list_captions` `upload_caption` `update_caption` `delete_caption` | Caption tracks (srt, vtt, sbv, ttml, dfxp, scc) | 50-450 |
| `list_comments` | Threads with replies, per video or channel-wide, incl. the review queue | 1 |
| `post_comment` `reply_to_comment` | Comment as your channel | 50 |
| `set_comment_moderation` | Hold, publish or reject comments by explicit id (max 25). Never bans authors | 50 |
| `delete_comment` | Delete one comment | 50 |
| `analytics_query` | YouTube Analytics reports (views, watch time, per video, per country, traffic sources...). No revenue | separate quota |

Every result ends with the estimated quota used, and `quota_status` keeps a running total per Pacific day in `~/.config/youtube-mcp/quota.json` (counts only calls made through this plugin). The default daily Data API quota is **10,000 units** (resets midnight Pacific), so about **6 uploads a day**.

## Things to know

- **Audio is not accepted.** YouTube needs a video container. For music, render audio + cover image to a video first (for example with `ffmpeg -loop 1 -i cover.png -i song.wav -c:v libx264 -tune stillimage -c:a aac -shortest out.mp4`).
- **AI disclosure.** `contains_synthetic_media` has no default so the caller must decide. Set it `true` for realistic AI-generated or altered people, places, events or audio. Undisclosed realistic synthetic content risks removal or Partner Program action. Content ID can still falsely flag AI music; disputes are done in YouTube Studio.
- **Claims.** Copyright / Content ID claims are not exposed by the YouTube Data API; `get_video` shows `rejection_reason`, `licensed_content` and `region_restriction`, everything else is in Studio.
- **Upload file name.** `upload_filename` is sent as a `Slug` header, which YouTube may ignore; the result reports `stored_file_name` so you can see what stuck. Renaming the local file is the reliable way.
- **Audit lock.** Videos uploaded through an API project that has not passed YouTube's API compliance audit are forced to private. The upload result warns when that happens; either set visibility in Studio or apply for the audit (same form raises quota).
- **Thumbnails** need a phone-verified channel.
- **Long uploads** block the tool call until finished. Interrupted network/5xx errors are resumed automatically.

## Safety

- Scopes: `youtube.force-ssl` (manage videos, playlists, captions, comments; covers uploads) and `yt-analytics.readonly`. No revenue scope, no partner scope.
- Defaults are conservative: private uploads, no subscriber notification, ids only (never "everything matching X"), deletes need a confirm id, comment moderation capped at 25 ids and never bans.
- Upload paths come from the model, so they are checked: real path, regular file, extension allowlist per kind (video / image / caption), size caps, never inside the config folder. Set `YOUTUBE_UPLOAD_DIRS` (':'-separated) to restrict reads to specific folders.
- Comments, descriptions and titles are untrusted input; tool descriptions say so.
- PII guard: results are masked before reaching the model, and titles, descriptions, tags and comments you publish are refused if they contain cards, keys, codes etc. `YOUTUBE_PII_MODE` = `mask` (default), `strict` or `off`. Best-effort regex, not a compliance control.

## Setup

Requires only `node` (committed, bundled `dist/`). Each user needs their own Google Cloud project:

1. Create a GCP project and enable **YouTube Data API v3** and **YouTube Analytics API**.
2. OAuth consent screen: **External**, publishing status **Testing**, add yourself as a **test user**, add scopes `youtube.force-ssl` and `yt-analytics.readonly`. Do not click "Publish app".
3. Create an OAuth client of type **Desktop app** and save its JSON as `~/.config/youtube-mcp/client_secret.json`.
4. Sign in once: `node dist/auth.js` (click **Advanced** > **Go to app (unsafe)** and tick every checkbox).
5. Install the plugin; Claude Code starts the server via `.mcp.json`. Run `auth_status` to confirm the channel.

In Testing mode the refresh token expires every 7 days; use the `youtube-reauth` skill (or `node dist/auth.js`).

## Development

`npm install`, then `npm run typecheck && npm run build` (bundles to the committed `dist/`). Env: `YOUTUBE_MCP_DIR` overrides the config dir, `YOUTUBE_UPLOAD_DIRS`, `YOUTUBE_PII_MODE`.
