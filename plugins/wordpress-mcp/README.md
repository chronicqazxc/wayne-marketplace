# wordpress-mcp

Self-hosted WordPress.com MCP server on the official REST API (`public-api.wordpress.com/rest/v1.1`). Replaces ad-hoc `curl` calls for drafting and editing posts. It knows nothing about blog-writing rules; those belong in the blog project.

## Tools

| Tool | Description |
|---|---|
| `wp_create_post` | Create a post (`title`, `content` or `content_file`, `content_format` `html`\|`markdown`, `status` default `draft`, `categories`, `tags`) |
| `wp_update_post` | Update a post by `id`; only provided fields change. Partial body changes via `edits` |
| `wp_get_post` | Metadata (ID, status, URL, title, modified) plus paths to local `.md` / `.html` copies of the body |
| `wp_list_posts` | List posts, optional `status` and `number` |
| `wp_delete_post` | Trash a post (permanent if already trashed) |
| `wp_auth_status` | Verify the token and show the targeted site |

Every post result includes `ID`, `status` and `URL`. Failures return `HTTP <status> <text>: <API message>` with `isError`.

## Keeping context small

- **Read:** `wp_get_post` never returns the body inline. It writes `wp-<id>.md` (HTML converted to Markdown, for reading) and `wp-<id>.html` (exact stored HTML, for grepping) to the scratch dir (`$TMPDIR/wordpress-mcp`, override with `WORDPRESS_MCP_SCRATCH`). `include_markdown=true` returns the Markdown inline for short posts.
- **Create:** write Markdown and pass `content_format: "markdown"`; the server converts it to HTML (GFM: tables, fenced code). Default format is `html` (raw, unchanged).
- **Edit:** pass `edits: [{find, replace, replace_all?}]` to `wp_update_post`. The server fetches the stored HTML, applies exact-string patches (each `find` must be unique unless `replace_all`) and pushes the result. Only the changed fragments cross the wire, and unrelated HTML is untouched.
- Avoid round-tripping an existing HTML post through Markdown (`wp_get_post` .md -> edit -> push as markdown): HTML to Markdown is lossy (inline styles, figures, iframes).
- `<script>`/`<style>` are stripped by WordPress.com on free plans; the plugin does not try to fix that.
- **Live-page guard.** Creating with `status=publish`, setting `status=publish`, updating a post that is already published, or deleting a published post is refused unless `confirm_live=true`. Results for published posts carry a `warning`.

## Configuration

| Setting | Env var | Fallback file |
|---|---|---|
| OAuth2 bearer token (long-lived) | `WORDPRESS_COM_TOKEN` | `~/.config/wordpress-mcp/token` |
| Site domain or blog ID | `WORDPRESS_COM_SITE` | `~/.config/wordpress-mcp/site` |

Env vars win. Example file setup (the token is read from the prompt, not shell history):

```shell
mkdir -p ~/.config/wordpress-mcp && chmod 700 ~/.config/wordpress-mcp
read -rs "t?token: " && printf '%s' "$t" > ~/.config/wordpress-mcp/token && unset t
chmod 600 ~/.config/wordpress-mcp/token
printf '%s' example.wordpress.com > ~/.config/wordpress-mcp/site
```

Also overridable: `WORDPRESS_MCP_HOME` (config dir), `WORDPRESS_COM_API_BASE`.

Getting a token: register an app at https://developer.wordpress.com/apps/, run the authorization-code flow against `https://public-api.wordpress.com/oauth2/authorize` and `/oauth2/token`. The token does not expire unless the app is revoked.

## Development

`npm install`, `npm run typecheck`, `npm run build` (bundles to `dist/`, which is committed so the plugin works without `npm install`).
