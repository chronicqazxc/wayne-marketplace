# prime-video-mcp

Self-hosted Amazon Prime Video availability MCP server (TypeScript on Node, stdio) built on the **official TMDB API**. Prime Video has no public catalog API, so availability comes from TMDB's watch-provider data (supplied by JustWatch). Read-only: it searches and reports, nothing more.

## Tools

| Tool | Description |
|---|---|
| `search_titles` | Search movies/TV by name; each result lists the countries where it is included with Prime. Pass `country` to keep only titles Prime Video offers there, with the four flags below |
| `check_availability` | Every country where one title (`tmdb_id` + `media_type`) is offered, with flags `prime`, `prime_with_ads`, `free_with_ads`, `rent_or_buy` |
| `browse_country` | Browse what is included with Prime in a country (20 per page) by genre name, year, production country (`origin_country`) and sort order. Rent/buy-only titles are not listed |
| `list_countries` | Countries where TMDB lists Prime Video as a subscription, with a `prime_with_ads` flag (`ad_plan_only` filters to those). No prices: TMDB does not provide them |

The flags: `prime` = included with a Prime subscription; `prime_with_ads` = on the Prime Video with Ads plan; `free_with_ads` = free to watch with ads, no subscription; `rent_or_buy` = rentable or purchasable on Amazon Video.

Countries are ISO 3166-1 alpha-2 codes (`US`, `JP`, `GB`). Titles and overviews are third-party text and treated as untrusted input.

## Setup

Requires only `node` (the server is a committed, bundled `dist/`).

1. Create a free account at <https://www.themoviedb.org> and request an API key at Settings > API (choose **Developer**; personal use is fine).
2. Save the key (the **API Read Access Token** starting with `eyJ`, or the v3 **API Key**). The script prompts with hidden input, verifies it against TMDB and saves it to `~/.config/prime-video-mcp/tmdb_key` (mode 0600):
   ```shell
   cd plugins/prime-video-mcp && node dist/auth.js
   ```
   Inside a Claude Code session (`!` commands have no terminal for the hidden prompt), copy the key and run `pbpaste | node dist/auth.js` instead. Or set `TMDB_API_KEY` in the environment (takes precedence).
3. Install the plugin; Claude Code starts the server via `.mcp.json`.

If a tool reports "No TMDB credential" or "TMDB rejected the credential", ask Claude to run the `prime-video-setup` skill.

## Limits

- Availability only: no leaving dates, audio or subtitle languages, and data can lag Prime Video by days.
- Covers TMDB providers Amazon Prime Video (119, plus legacy 9 in AT/DE/GB/JP/US), Prime Video with Ads (2100), Prime Video Free with Ads (613) and Amazon Video rent/buy (10). Amazon Channels (add-on subscriptions such as Paramount+) are other services and are not included.
- Data attribution: watch-provider data is provided by JustWatch, as TMDB requires. This product uses the TMDB API but is not endorsed or certified by TMDB.

## Development

`npm install`, then `npm run typecheck` and `npm run build` (bundles to the committed `dist/`). Env: `PRIME_VIDEO_MCP_DIR` overrides the config dir (default `~/.config/prime-video-mcp`).
