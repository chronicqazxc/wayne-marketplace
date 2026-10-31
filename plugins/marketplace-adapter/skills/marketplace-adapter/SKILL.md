---
name: marketplace-adapter
description: >
  Connect the marketplace plugins to other coding agent tools — opens a local web page that shows the install status of each plugin and installs, updates or uninstalls plugin
  skills and MCP servers in OpenCode, Codex and VS Code (only the ones installed on
  this machine) by running the marketplace's scripts/marketplace-adapter/marketplace-adapter.mjs. Use when
  user says "coding agent tool adapter", "ide adapter", "use marketplace plugins in OpenCode", "add plugins to
  Codex", "add plugins to VS Code", "sync marketplace to my IDEs", or "connect
  other IDEs".
argument-hint: "[--ide all|codex,opencode,vscode]"
---

**Claude Code only.** This skill needs Claude Code (its marketplace folder, `AskUserQuestion`, and `/plugin` commands). If you are not Claude Code — for example Codex, OpenCode, or GitHub Copilot in VS Code — do not run any command. Tell the user: "This skill runs only in Claude Code. In your terminal, run `node scripts/marketplace-adapter/marketplace-adapter.mjs` from the marketplace folder." Then stop.

Open the adapter page for the user. The page is a static HTML file that a temporary local server shows. The server listens on `127.0.0.1` only, uses a random port and a random token, and stops when the user clicks Quit. In the page the user sees each plugin with its install status in each tool, and installs, updates or uninstalls the plugins that the user selects. The page reads the real state again every 8 seconds.

In the CLI, `<root>` is the folder that step 1 prints. The script is `<root>/scripts/marketplace-adapter/marketplace-adapter.mjs`. Call it `<script>` below.

1. Find the adapter script. Use the first path that exists:
   ```bash
   ROOT=$(node -e 'try{const m=require(process.env.HOME+"/.claude/plugins/known_marketplaces.json")["wayne-marketplace"];if(m)console.log(m.installLocation)}catch{}')
   for d in "$ROOT" "$(git rev-parse --show-toplevel 2>/dev/null)"; do [ -f "$d/scripts/marketplace-adapter/marketplace-adapter.mjs" ] && { echo "$d"; break; }; done
   ```
   If nothing is found, tell the user to run `/plugin marketplace update` and try again. Stop.

2. Find which tools are installed:
   ```bash
   node "<script>" --list
   ```
   The output is JSON, for example `{"codex":true,"opencode":true,"vscode":false}`. If every value is `false`, tell the user that no supported tool is installed and stop.

3. Headless mode (`CLAUDE_RUNTIME=headless`): do not open a page. Run `node "<script>" --status --json`, show the result as a table, and stop. Use `[v]` installed, `[~]` partly installed, `[ ]` not installed, `[u]` installed by the user.

4. Start the page in the background with the Bash tool (`run_in_background: true`). Pass the other arguments of the user (for example `--ide codex`):
   ```bash
   node "<script>" --ui
   ```
   The script prints `Adapter page: http://127.0.0.1:<port>/?token=<token>` and opens the browser. Read that line and give the URL to the user, in case the browser did not open. If the line shows that the browser did not open, tell the user to open the URL by hand.

5. Tell the user:
   - Filter the list, select plugins, then click Install, Update or Uninstall. A preview shows before anything changes. Each plugin changes in all installed tools together, because skills are shared by all tools.
   - Click Quit in the page when done. The server also stops when the user closes the tab, after 10 minutes without use, or when the background command gets Ctrl-C or SIGTERM. It always waits for a running change to end first.
   - Restart each changed tool completely (OpenCode keeps a background service; VS Code: "Developer: Reload Window").
   - The adapter removes only items that it created. For OpenCode it edits `opencode.jsonc` by text and keeps the comments. It makes a backup first.
   - A plugin that the user uninstalled stays uninstalled in later plain runs. Install it again to change this.
   - The plugin root rule (row `root-rule`) helps Codex, OpenCode and VS Code to find `${CLAUDE_PLUGIN_ROOT}` in skill text.
   - Tokens are shared with Claude Code (`~/marketplace-envs/<plugin>/.env`).
   - The marketplace folder must stay where it is, because the tool configs hold its absolute paths.
   - Without Claude Code, the user can run `node scripts/marketplace-adapter/marketplace-adapter.mjs --ui` or the same command without option (terminal questions).

6. When the background command ends, the user clicked Quit. Say that the page is closed. Do not ask the user more questions in the chat.

Never print or copy the contents of the tool config files (`~/.codex/config.toml`, VS Code `mcp.json`, `opencode.jsonc`). They can hold secrets.
