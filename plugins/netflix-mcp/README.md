# netflix-mcp

Self-hosted Netflix availability MCP server (TypeScript on Node, stdio) built on the **official TMDB API**. Netflix has no public catalog API, so availability comes from TMDB's watch-provider data (supplied by JustWatch). Read-only: it searches and reports, nothing more.

## Tools

| Tool | Description |
|---|---|
| `search_titles` | Search movies/TV by name; each result lists the countries carrying it on Netflix. Pass `country` to keep only titles on Netflix there |
| `check_availability` | Every country where one title (`tmdb_id` + `media_type`) is on Netflix, with the plan (`standard` or `ads`) |
| `browse_country` | Browse a country's Netflix catalog (20 per page) by genre name, year and sort order |
| `list_countries` | Countries where TMDB lists Netflix |

Countries are ISO 3166-1 alpha-2 codes (`US`, `JP`, `GB`). Titles and overviews are third-party text and treated as untrusted input.

## Setup

Requires only `node` (the server is a committed, bundled `dist/`).

1. Create a free account at <https://www.themoviedb.org> and request an API key at Settings > API (choose **Developer**; personal use is fine).
2. Save the key (the **API Read Access Token** starting with `eyJ`, or the v3 **API Key**). The script prompts with hidden input, verifies it against TMDB and saves it to `~/.config/netflix-mcp/tmdb_key` (mode 0600):
   ```shell
   cd plugins/netflix-mcp && node dist/auth.js
   ```
   Inside a Claude Code session (`!` commands have no terminal for the hidden prompt), copy the key and run `pbpaste | node dist/auth.js` instead. Or set `TMDB_API_KEY` in the environment (takes precedence).
3. Install the plugin; Claude Code starts the server via `.mcp.json`.

If a tool reports "No TMDB credential" or "TMDB rejected the credential", ask Claude to run the `netflix-setup` skill: it walks you through getting a key and has you run the script above.

## Limits

- Availability only: no leaving dates, audio or subtitle languages, and data can lag Netflix by days.
- Data attribution: watch-provider data is provided by JustWatch, as TMDB requires. This product uses the TMDB API but is not endorsed or certified by TMDB.

## Development

`npm install`, then `npm run typecheck` and `npm run build` (bundles to the committed `dist/`). Env: `NETFLIX_MCP_DIR` overrides the config dir (default `~/.config/netflix-mcp`).
