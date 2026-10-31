# marketplace-adapter: internals

This folder holds the code of the marketplace adapter. It has two parts:

- A command line tool that connects the marketplace plugins to OpenCode, Codex and VS Code.
- A local management page (`--ui`) to see the install status of each plugin, and to install, update or uninstall the plugins.

Both parts use the same engine (`core.mjs`).
For how to start the adapter and manage the installation, read
[plugins/marketplace-adapter/README.md](../../plugins/marketplace-adapter/README.md).
This file explains how the code works for each tool.

## Files

| File | Purpose |
|---|---|
| `marketplace-adapter.mjs` | Entry point. Sets the paths and runs the command line. |
| `core.mjs` | Finds the plugins, has one driver for each tool, makes the plan, and runs it. |
| `args.mjs` | Reads the command line options. |
| `jsonc.mjs` | Reads JSONC. Removes one server from `opencode.jsonc` and keeps the comments. |
| `ui.mjs`, `ui.html` | The management page. `ui.mjs` is a local server on `127.0.0.1` with a random port and token. `ui.html` is the page. |
| `marketplace-root.md` | The root rule that the tools read. |
| `test/` | Tests. Run `node --test scripts/marketplace-adapter/test/*.test.mjs`. |

## What the adapter reads

For each folder in `plugins/` the adapter reads:

- `skills/<name>/SKILL.md`. The name in the file must equal the folder name and must be in kebab-case.
- `mcpServers` in `.claude-plugin/plugin.json`. Each server needs `command` or `url`.
- The adapter replaces `${CLAUDE_PLUGIN_ROOT}` with the absolute path of the plugin folder.
  It also sets `CLAUDE_PLUGIN_ROOT` as an environment variable of the server.
- The adapter skips a plugin that has a `.do-not-migrate` file.

The adapter writes absolute paths. The folder that holds the script is the source folder.

## Skills

Codex, OpenCode and VS Code share one folder: `~/.agents/skills`.

- The adapter makes a symlink for each `skills/<name>/SKILL.md` in `~/.agents/skills/<name>`.
- The adapter does not copy the skill files. The symlink points to the source folder.
- A plain run repoints a symlink that points to another place. It never removes a real folder of the user.
- Set `ADAPTER_SKILLS_DIR` to use another folder.

## MCP servers

The adapter has one driver for each tool. Each driver can find, add, and remove a server.
MCP has no shared folder, so each tool has its own config file.

| Tool | Config file | Find | Add | Remove |
|---|---|---|---|---|
| OpenCode | `~/.config/opencode/opencode.jsonc` | `opencode debug config`. Reads the names from `info.mcp` and `info.mcp.servers`. | `opencode mcp add --global <name>` | Edits the file text with `jsoncRemoveServer`. OpenCode v2 has no `mcp remove` command. |
| Codex | `~/.codex/config.toml` | `codex mcp list --json` | `codex mcp add <name>` | `codex mcp remove <name>` |
| VS Code | `~/Library/Application Support/Code/User/mcp.json` (macOS), `~/.config/Code/User/mcp.json` (other systems) | Reads the file. Reads the `servers` key. | Writes `servers.<name>` in the file. | Deletes `servers.<name>` from the file. |

An update removes the server and adds it again.

### OpenCode and Codex

Both tools have a command to add a server. The adapter calls the command and does not edit the config file.

- Environment variables: the adapter passes each variable as `--env KEY=VALUE`.
- Remote server: the adapter passes `--url <url>`.
- Local server: the adapter passes `-- <command> <args>`.
- OpenCode: the adapter runs the command from the home folder, and adds `--global`. Then the server is global, not for one project.
- OpenCode remove: the adapter backs up `opencode.jsonc`, then removes the server from the text.
  The name can be in `mcp.<name>` and in `mcp.servers.<name>`, so the adapter removes it up to 5 times.
  The adapter refuses to write if it cannot remove the server safely. Then it asks you to remove the server by hand.

### VS Code

VS Code has no command to add a server. The adapter writes the `servers` key of `mcp.json` directly.

- Remote server: `{ "type": "http", "url": "..." }`.
- Local server: `{ "type": "stdio", "command": "/bin/bash", "args": ["-c", "<script>", "marketplace-adapter", ...cmd], "cwd": ..., "env": ... }`.
- VS Code that starts from the Dock has a short `PATH`. So the `-c` script sets `CLAUDE_PLUGIN_ROOT` and `PATH`, then goes to the plugin folder, then runs the command.
  The `PATH` has the folder of the `node` binary that runs the adapter, and the usual Homebrew and `mise` folders.
- Before each change the adapter reads the file again and changes only one key. An edit that you make at the same time is not lost.
- A rewrite removes the comments in the file. The adapter makes one backup for each run.
- If the file is not valid JSON, the adapter stops with an error and does not write.

## Root rule

A skill can use `${CLAUDE_PLUGIN_ROOT}` in its text. The root rule tells the tool where to find the plugin folder.

| Tool | Where the rule goes |
|---|---|
| OpenCode | A block between markers in `~/.config/opencode/AGENTS.md` |
| Codex | A block between markers in `~/.codex/AGENTS.md` |
| VS Code | The file `~/.copilot/instructions/plugin-root.instructions.md`. The adapter owns the whole file. |

The block tells the tool to read `marketplace-root.md` (linked in `~/.agents`) first.
The adapter does not touch a file with a broken marker pair.

## Plan and ownership

- The adapter makes a plan first (`--dry-run` shows it), then runs the steps.
- The adapter records the items that it created in `~/.marketplace-adapter/state.json`.
  It changes or removes only these items. It leaves an item that the user created.
- A plain run adds what is missing. It does not rewrite an MCP server that exists. Use `--update` for that.
- A plain run shows `! <tool>: <server> points to another folder — run update to repoint it`
  when an MCP server uses another source folder than the one of the script. The warning does not change the entry.
  For VS Code the check looks at the command arguments and the URL. It ignores `cwd` and `env`.

## Environment variables (for tests)

| Variable | Default |
|---|---|
| `ADAPTER_SKILLS_DIR` | `~/.agents/skills` |
| `ADAPTER_STATE_FILE` | `~/.marketplace-adapter/state.json` |
| `ADAPTER_OPENCODE_CONFIG` | `~/.config/opencode/opencode.jsonc` |
| `ADAPTER_OPENCODE_AGENTS` | `~/.config/opencode/AGENTS.md` |
| `ADAPTER_CODEX_AGENTS` | `~/.codex/AGENTS.md` |
| `ADAPTER_VSCODE_MCP` | VS Code user `mcp.json` |
| `ADAPTER_VSCODE_INSTRUCTIONS` | `~/.copilot/instructions/plugin-root.instructions.md` |
| `OPENCODE_BIN` | `opencode` in `PATH`, or the Homebrew binary |

Do not print or share the tool config files. They can hold secrets.
