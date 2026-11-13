# Wayne Marketplace

A personal Claude Code plugin marketplace.

## Layout

```
.claude-plugin/marketplace.json   # marketplace manifest
plugins/<name>/.claude-plugin/plugin.json
scripts/marketplace-adapter/      # engine behind the adapter example below
```

## Example: sharing this marketplace with other tools

`marketplace-adapter` is a reference example, not an MCP server. It links a marketplace's plugin skills and MCP servers into OpenCode, Codex and VS Code. Run `/marketplace-adapter` in Claude Code, or `node scripts/marketplace-adapter/marketplace-adapter.mjs --ui` from this folder. See `plugins/marketplace-adapter/README.md`.

It reads MCP servers from `mcpServers` in `plugin.json`. The plugins here declare theirs in `.mcp.json`, so the adapter currently links only their skills.

## Adding a plugin

1. Create `plugins/<name>/` with `.claude-plugin/plugin.json`.
2. Register it in `.claude-plugin/marketplace.json` under `plugins` (`name`, `source`, `description`, `version`).
3. Bump the marketplace `metadata.version`.

### External plugins

A plugin that lives in its own repo needs no folder here. Append an entry to `plugins` in `.claude-plugin/marketplace.json` and bump `metadata.version`:

```json
{
  "name": "lan-agent-hub",
  "description": "...",
  "category": "development",
  "homepage": "https://github.com/<owner>/<repo>",
  "source": { "source": "url", "url": "https://github.com/<owner>/<repo>.git", "ref": "main", "sha": "<full commit sha>" }
}
```

For a plugin in a subfolder of a bigger repo use `"source": "git-subdir"` with `url` and `path`. `sha` is optional; without it installs follow `ref`.

## Installation

```shell
/plugin marketplace add <path-or-git-url>
/plugin install <plugin>@wayne-marketplace --scope user
```
