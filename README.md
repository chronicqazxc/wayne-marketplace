# Wayne Marketplace

A personal Claude Code plugin marketplace.

## Layout

```
.claude-plugin/marketplace.json   # marketplace manifest
plugins/<name>/.claude-plugin/plugin.json
```

## Adding a plugin

1. Create `plugins/<name>/` with `.claude-plugin/plugin.json`.
2. Register it in `.claude-plugin/marketplace.json` under `plugins` (`name`, `source`, `description`, `version`).
3. Bump the marketplace `metadata.version`.

## Installation

```shell
/plugin marketplace add <path-or-git-url>
/plugin install <plugin>@wayne-marketplace --scope user
```
