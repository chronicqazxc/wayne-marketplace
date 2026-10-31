# disney-mcp

Self-hosted Disney+ availability MCP server (TypeScript on Node, stdio) built on the **official TMDB API**. Disney+ has no public catalog API, so availability comes from TMDB's watch-provider data (supplied by JustWatch). Read-only: it searches and reports, nothing more.

## Tools

| Tool | Description |
|---|---|
| `search_titles` | Search movies/TV by name; each result lists the countries carrying it on Disney+. Pass `country` to keep only titles on Disney+ there |
| `check_availability` | Every country where one title (`tmdb_id` + `media_type`) is on Disney+ |
| `browse_country` | Browse a country's Disney+ catalog (20 per page) by genre name, year, production country (`origin_country`) and sort order |
| `list_countries` | Countries where TMDB lists Disney+ |

Countries are ISO 3166-1 alpha-2 codes (`US`, `JP`, `GB`). Titles and overviews are third-party text and treated as untrusted input.

## Setup

Requires only `node` (the server is a committed, bundled `dist/`).

1. Create a free account at <https://www.themoviedb.org> and request an API key at Settings > API (choose **Developer**; personal use is fine).
2. Save the key (the **API Read Access Token** starting with `eyJ`, or the v3 **API Key**). The script prompts with hidden input, verifies it against TMDB and saves it to `~/.config/disney-mcp/tmdb_key` (mode 0600):
   ```shell
   cd plugins/disney-mcp && node dist/auth.js
   ```
   Inside a Claude Code session (`!` commands have no terminal for the hidden prompt), copy the key and run `pbpaste | node dist/auth.js` instead. Or set `TMDB_API_KEY` in the environment (takes precedence).
3. Install the plugin; Claude Code starts the server via `.mcp.json`.

If a tool reports "No TMDB credential" or "TMDB rejected the credential", ask Claude to run the `disney-setup` skill.

## Limits

- Availability only: no leaving dates, audio or subtitle languages, and data can lag Disney+ by days.
- No ad-plan information: TMDB has no separate provider for the ad-supported tier.
- Covers TMDB providers Disney Plus (337) and the legacy Disney+ entry (122, GB/ID/IN/MY/TH). JioHotstar (India) is a different service and is not included.
- Data attribution: watch-provider data is provided by JustWatch, as TMDB requires. This product uses the TMDB API but is not endorsed or certified by TMDB.

## Development

`npm install`, then `npm run typecheck` and `npm run build` (bundles to the committed `dist/`). Env: `DISNEY_MCP_DIR` overrides the config dir (default `~/.config/disney-mcp`).
