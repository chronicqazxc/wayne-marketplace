#!/usr/bin/env node
// marketplace-adapter — connects Claude Code format plugins in plugins/ to other coding agent tools.
// Plugins stay unchanged. This script only reads them:
//   skills/<name>/SKILL.md                      -> symlink in ~/.agents/skills (Codex, OpenCode, VS Code)
//   .claude-plugin/plugin.json "mcpServers"     -> Codex (codex mcp add), OpenCode (opencode mcp add --global),
//                                                  VS Code (user mcp.json)
// A plugin folder that contains a file named .do-not-migrate is skipped completely (Claude Code only plugin).
// ${CLAUDE_PLUGIN_ROOT} is replaced by the absolute plugin path and also set as an env var.
// The logic is in core.mjs (tested with `node --test scripts/marketplace-adapter/test`). This file only reads the command line.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAdapter, parseSelection, AdapterError, TOOLS, LABEL } from './core.mjs';
import { parseArgs } from './args.mjs';
import { startUi } from './ui.mjs';

const USAGE = `Usage: node marketplace-adapter.mjs [options]
  (no option, in a terminal)  interactive: choose tools, then install / update / uninstall plugins
  --yes               no questions: install every plugin that the user did not uninstall (default outside a terminal)
  --status [--json]   show the state of each plugin in each chosen tool, then exit
  --install a,b       install plugins (or "all")     --update a,b   update plugins (or "all")
                      add @tools to limit a plugin to some tools, for example  a@codex+vscode,b  (no @ = all chosen tools)
  --uninstall a,b     uninstall plugins (names only). Only items that the adapter created are removed.
                      "root-rule" is the name of the plugin root rule
  --ide codex,opencode,vscode   tools to use (default: all)
  --dry-run           show the plan, change nothing
  --check             like --dry-run, exit 1 if something would change (for CI)
  --force             in a plain run, install again items that the user removed with the tool's own commands
  --ui [--no-open]    open a temporary local web page (127.0.0.1) to see the state and install / update / uninstall each plugin
  --list              print which tools are installed as JSON, then exit
  --no-plugin-root-rule   do not manage the plugin root rule`;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function buildConfig(env = process.env) {
  const home = os.homedir();
  const run = (cmd, a, o = {}) => spawnSync(cmd, a, { encoding: 'utf8', ...o });
  const which = (c) => run('/usr/bin/env', ['which', c]).status === 0;
  const fallback = '/opt/homebrew/lib/node_modules/@opencode/cli/bin/opencode.exe';
  const skillsDir = env.ADAPTER_SKILLS_DIR || path.join(home, '.agents', 'skills');
  return {
    home, run, nodePath: process.execPath, envPath: env.PATH, skillsDir,
    pluginsDir: path.join(ROOT, 'plugins'),
    stateFile: env.ADAPTER_STATE_FILE || path.join(home, '.marketplace-adapter', 'state.json'),
    vscodeMcp: env.ADAPTER_VSCODE_MCP || (process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
      : path.join(home, '.config', 'Code', 'User', 'mcp.json')),
    opencodeConfig: env.ADAPTER_OPENCODE_CONFIG || path.join(home, '.config', 'opencode', 'opencode.jsonc'),
    ruleSrc: path.join(ROOT, 'scripts', 'marketplace-adapter', 'marketplace-root.md'),
    ruleLink: path.join(path.dirname(skillsDir), 'marketplace-root.md'),
    codexAgents: env.ADAPTER_CODEX_AGENTS || path.join(home, '.codex', 'AGENTS.md'),
    opencodeAgents: env.ADAPTER_OPENCODE_AGENTS || path.join(home, '.config', 'opencode', 'AGENTS.md'),
    vscodeRuleFile: env.ADAPTER_VSCODE_INSTRUCTIONS || path.join(home, '.copilot', 'instructions', 'plugin-root.instructions.md'),
    bins: { codex: which('codex') ? 'codex' : null, opencode: env.OPENCODE_BIN || (which('opencode') ? 'opencode' : fs.existsSync(fallback) ? fallback : null) },
  };
}

const MARK = (s) => (s.state === 'none' ? '[ ]' : s.state === 'partial' ? '[~]' : s.external ? '[u]' : '[v]');
export function renderTable(rows, tools) {
  const w = Math.max(...rows.map((r) => r.name.length), 6);
  const out = [`\n${'#'.padStart(3)}  ${'Plugin'.padEnd(w)}  ${tools.map((t) => LABEL[t].padEnd(8)).join(' ')}  Items`];
  for (const r of rows) {
    const items = r.kind === 'rule' ? 'global rule about ${CLAUDE_PLUGIN_ROOT}' : [r.skills && `${r.skills} skill${r.skills > 1 ? 's' : ''}`, r.mcp && `${r.mcp} MCP`].filter(Boolean).join(', ');
    out.push(`${String(r.index).padStart(3)}  ${r.name.padEnd(w)}  ${tools.map((t) => MARK(r.state[t]).padEnd(8)).join(' ')}  ${items}`);
  }
  out.push('\n[v] installed   [~] partly installed   [ ] not installed   [u] installed by the user (the adapter does not change it)',
    'Skills are shared by all tools. MCP servers are separate for each tool.');
  return out.join('\n');
}

// deps (all optional, for tests): cfg, env, out, err, isTTY, ask
export async function main(argv, deps = {}) {
  const out = deps.out || console.log; const err = deps.err || console.error;
  let a;
  try { a = parseArgs(argv, { isTTY: deps.isTTY ?? !!(process.stdin.isTTY && process.stdout.isTTY) }); } catch (e) { err(`${e.message}\n\n${USAGE}`); return 2; }
  if (a.mode === 'help') { out(USAGE); return 0; }
  const say = a.flags.json ? err : out; // --json keeps stdout clean
  const base = deps.cfg || buildConfig(deps.env || process.env);
  const cfg = { ...base, log: say, includeRule: base.includeRule !== false && !a.flags['no-plugin-root-rule'] };
  let ad;
  try { ad = createAdapter(cfg); } catch (e) { if (!(e instanceof AdapterError)) throw e; err(e.message); return 1; }
  if (a.mode === 'list') { out(JSON.stringify(ad.found())); return 0; }
  if (a.mode === 'ui') {
    const makeAdapter = (log) => createAdapter({ ...base, log, includeRule: cfg.includeRule });
    return startUi({ makeAdapter, out, open: deps.open ?? !a.flags['no-open'] });
  }

  let rl = null;
  const ask = deps.ask || ((q) => (rl ||= readline.createInterface({ input: process.stdin, output: process.stdout })).question(q));
  try {
    ad.discover().warnings.forEach((w) => say(w));
    let tools = a.tools;
    if (a.mode === 'interactive' && !a.ideGiven) { // question 1
      const avail = TOOLS.filter((t) => ad.found()[t]);
      if (!avail.length) { say('No supported tool found (Codex, OpenCode, VS Code). Nothing to do.'); return 0; }
      out('\nStep 1. Choose the coding agent tools:'); avail.forEach((t, n) => out(`  ${n + 1}) ${LABEL[t]}`));
      const ans = (await ask('Numbers separated by commas, or Enter for all: ')).trim();
      tools = !ans || ans.toLowerCase() === 'all' ? avail : [...new Set(ans.split(/[,\s]+/).map((x) => avail[Number(x) - 1]).filter(Boolean))];
      if (!tools.length) { say('No tool chosen. Nothing to do.'); return 0; }
    }
    const { usable, messages } = ad.usableTools(tools);
    messages.forEach((m) => say(m));
    if (!usable.length) { say('No supported tool found (Codex, OpenCode, VS Code). Nothing to do.'); return 0; }
    const rows = ad.status(usable);
    const plugins = ad.discover().plugins;
    const head = (label) => say(`plugins: ${plugins.reduce((n, p) => n + p.skills.length, 0)} skills, ${plugins.reduce((n, p) => n + p.servers.length, 0)} MCP servers  (${label}; tools: ${usable.join(',')})`);

    if (a.mode === 'status') {
      if (a.flags.json) out(JSON.stringify({ tools: usable, rows }, null, 2)); else { head('status'); out(renderTable(rows, usable)); }
      return 0;
    }

    let steps; let dry = !!(a.flags['dry-run'] || a.flags.check);
    const planOpts = { force: !!a.flags.force };
    if (a.mode === 'sync') { head(dry ? 'dry-run' : 'apply'); steps = ad.plan({ sync: true }, usable, planOpts); }
    else if (a.mode === 'explicit') {
      try { steps = ad.plan(ad.resolveRequest(a.request), usable, planOpts); } catch (e) { if (!(e instanceof AdapterError)) throw e; err(e.message); return 2; }
      head(dry ? 'dry-run' : 'apply');
    } else { // interactive: question 2
      head('interactive'); out(renderTable(rows, usable));
      out('\nStep 2. Choose the plugins. Type numbers (for example 1,4-6) or names. Press Enter to skip a question.');
      const raw = {};
      for (const [action, q] of [['install', 'Install   (also "all"): '], ['update', 'Update    (also "all"): '], ['uninstall', 'Uninstall           : ']]) {
        const r = parseSelection(await ask(q), action, rows); raw[action] = r.names;
        r.warnings.forEach((w) => out(w));
      }
      let req; try { req = ad.resolveRequest(raw); } catch (e) { if (!(e instanceof AdapterError)) throw e; out(`${e.message}\nNothing changed.`); return 0; }
      steps = ad.plan(req, usable, planOpts);
      out('\nPlan:'); ad.lines(steps).forEach((l) => out(l));
      const n = ad.changeCount(steps);
      if (!n) { out('Nothing to change.'); return 0; }
      const yes = (await ask(`\nApply ${n} change(s)? [y/N] `)).trim().toLowerCase();
      if (yes !== 'y' && yes !== 'yes') { out('Cancelled. Nothing changed.'); return 0; }
      dry = false; out('');
    }

    const n = ad.changeCount(steps);
    if (dry) ad.lines(steps).forEach((l) => out(l)); else ad.execute(steps);
    say(n ? `${n} item(s) ${dry ? 'would change' : 'changed'}. Restart the tool to load the changes.` : 'up to date');
    return a.flags.check && n ? 1 : 0;
  } finally { rl?.close(); }
}

// Run only when started as a script, not when a test imports this file.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.exit(await main(process.argv.slice(2)));
}
