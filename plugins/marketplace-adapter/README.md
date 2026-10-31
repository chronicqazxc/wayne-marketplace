# marketplace-adapter

Connect the marketplace plugins to OpenCode, Codex and VS Code.
The adapter reads the plugins in `plugins/`. It does not change them.

| Plugin item | What the adapter does |
|---|---|
| `skills/<name>/SKILL.md` | Makes a symlink in `~/.agents/skills/<name>`. Codex, OpenCode and VS Code share this folder. |
| `mcpServers` in `.claude-plugin/plugin.json` | Adds the MCP server to each tool: `codex mcp add`, `opencode mcp add --global`, and the VS Code user `mcp.json`. |
| `${CLAUDE_PLUGIN_ROOT}` | Replaced by the absolute path of the plugin folder. Also set as an environment variable. |
| `.do-not-migrate` file in a plugin folder | The adapter skips the whole plugin (Claude Code only plugin). |

The adapter also installs a "root-rule" that tells the tools how to find `${CLAUDE_PLUGIN_ROOT}` in skill text.
The adapter removes only items that it created. It records them in `~/.marketplace-adapter/state.json`.

## Start the adapter

### From Claude Code

Run `/marketplace-adapter`. A local web page opens (127.0.0.1 only).
The page pre-selects the plugins that the adapter already installed. Change the selection, then click Install, Update or Uninstall. Click Quit when done.

The source folder is the marketplace clone:
`~/.claude/plugins/marketplaces/wayne-marketplace`.

### From the Terminal

Run from the root of a marketplace folder:

```bash
node scripts/marketplace-adapter/marketplace-adapter.mjs --ui
```

| Option | Result |
|---|---|
| (none, in a terminal) | Interactive questions |
| `--ui [--no-open]` | Web page |
| `--status [--json]` | Show the state of each plugin in each tool |
| `--install a,b` / `--update a,b` / `--uninstall a,b` | Change plugins. Use `all` for every plugin. |
| `--ide codex,opencode,vscode` | Limit the tools. Default: all installed tools. |
| `--dry-run` | Show the plan. Change nothing. |
| `--check` | Same as `--dry-run`. Exit code 1 if a change is needed. |
| `--force` | Install again items that you removed with the tool's own commands. |
| `--list` | Show which tools are installed (JSON). |

The source folder is the folder that holds the script. For example, your own clone in `~/Developer`.

## Which source folder? (important)

The adapter writes absolute paths. The tools use the files in the folder of the last run.

| Run from | Skills and MCP servers use |
|---|---|
| Claude Code | `~/.claude/plugins/marketplaces/wayne-marketplace` (updated by Claude Code) |
| Terminal in your own clone | Your clone. Your local edits and branch are visible to the tools. |

Rules:

1. Use one source folder at a time.
2. A plain run (`--yes`, interactive, or `--ui` Install) repoints the skill symlinks. It does **not** rewrite MCP servers that exist. It shows a warning `points to another folder` for each Codex, OpenCode or VS Code server that uses another source folder.
3. To move everything to a new source folder, run `--update all` from that folder.
4. Do not move or delete the source folder. The symlinks and MCP paths break.

### Switch the source folder

```bash
cd <new source folder>
node scripts/marketplace-adapter/marketplace-adapter.mjs --update all --dry-run
node scripts/marketplace-adapter/marketplace-adapter.mjs --update all
```

Then restart each tool completely. OpenCode keeps a background service. In VS Code run "Developer: Reload Window".

## Manage the installation

| Task | Command |
|---|---|
| Check the state | `--status` |
| Install one plugin | `--install example-plugin` |
| Install in one tool only | `--install example-plugin@codex` (join tools with `+`, for example `@codex+vscode`) |
| Get new plugin files or new MCP settings | `--update all` |
| Remove a plugin | `--uninstall example-plugin` |
| Remove the root rule | `--uninstall root-rule` |
| Skip the root rule | `--no-plugin-root-rule` |

A plugin that you uninstalled stays uninstalled in later plain runs. Install it again to change this.

## Notes

- Tokens are shared with Claude Code: `~/marketplace-envs/<plugin>/.env`.
- Each MCP server needs its own `node_modules` in the plugin folder of the source folder.
- OpenCode: the adapter edits `opencode.jsonc` as text and keeps the comments. It makes a backup first.
- Do not print or share the tool config files (`~/.codex/config.toml`, VS Code `mcp.json`, `opencode.jsonc`). They can hold secrets.
- Tests: `node --test scripts/marketplace-adapter/test`.
