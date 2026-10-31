# Marketplace: plugin root rule

Skills in this marketplace are written for Claude Code. Claude Code replaces `${CLAUDE_PLUGIN_ROOT}` in the skill text with the plugin folder. Other IDEs (Codex, OpenCode) do not replace it, and the variable is empty in their shell.

When a skill uses `${CLAUDE_PLUGIN_ROOT}`:

1. Run `realpath` on the skill folder. The skill folder is a symlink in `~/.agents/skills/<skill>`.
2. The real path has the form `<marketplace>/plugins/<plugin>/skills/<skill>`.
3. The plugin root is two levels above the skill folder: `<marketplace>/plugins/<plugin>`.
4. Use this path wherever the skill text says `${CLAUDE_PLUGIN_ROOT}`, also in shell commands.

Do not use a path under `~/.claude/plugins/cache/`. That folder is an old copy that Claude Code made.
