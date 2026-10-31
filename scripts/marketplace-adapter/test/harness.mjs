// Test harness: a temporary machine with fake Codex and OpenCode, real files, and fixture plugins.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAdapter } from '../core.mjs';
import { parseJsonc } from '../jsonc.mjs';

export const OC_CONFIG = `{
  // my own comment
  "model": "glm",
  "mcp": {
    "rai-code-mcphub": { "type": "remote", "url": "http://x" },
    "servers": {
      // servers comment
      "user-own-server": { "type": "local", "command": ["y"] }
    }
  }
}
`;

export function makeEnv({ vscodeDir = true, ruleSrc = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-test-')));
  const p = (...x) => path.join(root, ...x);
  const logs = []; const calls = [];
  const codexNames = new Set(); const codexCmd = new Map(); const codexUrl = new Map();
  const fail = { codexAdd: new Set(), codexRemove: new Set(), opencodeAdd: new Set(), codexList: false, opencodeList: false, opencodeGarbage: false };
  let clock = 1000;

  fs.mkdirSync(p('plugins'), { recursive: true });
  fs.mkdirSync(p('oc'), { recursive: true });
  fs.writeFileSync(p('oc', 'opencode.jsonc'), OC_CONFIG);
  if (vscodeDir) fs.mkdirSync(p('vscode', 'User'), { recursive: true });
  if (ruleSrc) fs.writeFileSync(p('rule.md'), '# rule\n');

  const run = (cmd, args) => {
    if (cmd === 'codex') {
      if (args[1] === 'list') return fail.codexList ? { status: 1, stdout: '', stderr: 'boom' } : { status: 0, stdout: JSON.stringify([...codexNames].map((name) => ({ name, transport: codexUrl.has(name) ? { type: 'streamable_http', url: codexUrl.get(name) } : codexCmd.has(name) ? { type: 'stdio', command: codexCmd.get(name)[0], args: codexCmd.get(name).slice(1) } : undefined }))), stderr: '' };
      if (args[1] === 'add') {
        calls.push(`codex add ${args[2]}`);
        if (fail.codexAdd.has(args[2])) return { status: 1, stdout: '', stderr: 'add refused' };
        codexNames.add(args[2]); if (args.includes('--url')) codexUrl.set(args[2], args[args.indexOf('--url') + 1]); if (args.includes('--')) codexCmd.set(args[2], args.slice(args.indexOf('--') + 1)); return { status: 0, stdout: '', stderr: '' };
      }
      if (args[1] === 'remove') {
        calls.push(`codex remove ${args[2]}`);
        if (fail.codexRemove.has(args[2])) return { status: 1, stdout: '', stderr: 'remove refused' };
        codexNames.delete(args[2]); return { status: 0, stdout: '', stderr: '' };
      }
    }
    if (cmd === 'opencode') {
      const file = p('oc', 'opencode.jsonc');
      if (args[0] === 'debug') {
        if (fail.opencodeList) return { status: 1, stdout: '', stderr: 'boom' };
        if (fail.opencodeGarbage) return { status: 0, stdout: 'not json', stderr: '' };
        try { return { status: 0, stdout: JSON.stringify([{ info: { mcp: parseJsonc(fs.readFileSync(file, 'utf8')).mcp } }]), stderr: '' }; }
        catch { return { status: 1, stdout: '', stderr: 'config error' }; }
      }
      if (args[0] === 'mcp' && args[1] === 'add') {
        const name = args[3]; calls.push(`opencode add ${name}`);
        if (fail.opencodeAdd.has(name)) return { status: 1, stdout: '', stderr: 'add refused' };
        const text = fs.readFileSync(file, 'utf8'); const dash = args.indexOf('--'); // the real tool records the command after "--"
        fs.writeFileSync(file, text.replace('"servers": {', `"servers": {\n      "${name}": ${args.includes('--url') ? JSON.stringify({ type: 'remote', url: args[args.indexOf('--url') + 1] }) : `{ "type": "local", "command": ${JSON.stringify(dash >= 0 ? args.slice(dash + 1) : ['x'])} }`},`));
        return { status: 0, stdout: '', stderr: '' };
      }
    }
    return { status: 127, stdout: '', stderr: `unknown command ${cmd}` };
  };

  const cfg = {
    home: p('home'), pluginsDir: p('plugins'), skillsDir: p('agents', 'skills'), stateFile: p('state', 'state.json'),
    vscodeMcp: p('vscode', 'User', 'mcp.json'), opencodeConfig: p('oc', 'opencode.jsonc'),
    ruleSrc: p('rule.md'), ruleLink: p('agents', 'marketplace-root.md'),
    codexAgents: p('codex', 'AGENTS.md'), opencodeAgents: p('oc', 'AGENTS.md'), vscodeRuleFile: p('vsi', 'r.instructions.md'),
    nodePath: '/usr/bin/node', envPath: '/usr/bin:/bin', now: () => clock++,
    bins: { codex: 'codex', opencode: 'opencode' }, log: (m) => logs.push(m), run,
  };

  const env = {
    root, p, cfg, logs, calls, codexNames, fail,
    // A new adapter object = a new process: it reads the state file again. The fake tools keep their state.
    adapter: (extra = {}) => createAdapter({ ...cfg, ...extra }),
    // plan + execute in one call. Returns the steps.
    apply(req, tools = ['codex', 'opencode', 'vscode'], opts = {}) {
      const ad = env.adapter();
      const steps = ad.plan(req, tools, opts); ad.execute(steps); return steps;
    },
    sync: (tools, opts) => env.apply({ sync: true }, tools, opts),
    steps: (req, tools = ['codex', 'opencode', 'vscode'], opts = {}) => env.adapter().plan(req, tools, opts),
    changes: (steps) => steps.filter((s) => ['add', 'update', 'remove'].includes(s.kind)).map((s) => s.text),
    texts: (steps) => steps.filter((s) => s.text).map((s) => s.text),
    state: () => (fs.existsSync(cfg.stateFile) ? JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8')) : {}),
    vscodeServers: () => (fs.existsSync(cfg.vscodeMcp) ? JSON.parse(fs.readFileSync(cfg.vscodeMcp, 'utf8')).servers : {}),
    ocText: () => fs.readFileSync(cfg.opencodeConfig, 'utf8'),
    link: (name) => path.join(cfg.skillsDir, name),
    isLink: (f) => { try { return fs.lstatSync(f).isSymbolicLink(); } catch { return false; } },
    clearLogs: () => { logs.length = 0; calls.length = 0; },
    // fixture plugins
    addPlugin(name, { servers = {}, skills = [], doNotMigrate = false, rawManifest = null, noManifest = false } = {}) {
      const dir = p('plugins', name); fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
      if (!noManifest) fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), rawManifest ?? JSON.stringify({ name, mcpServers: servers }));
      if (doNotMigrate) fs.writeFileSync(path.join(dir, '.do-not-migrate'), '');
      for (const s of skills) {
        const [dirName, fmName] = Array.isArray(s) ? s : [s, s];
        fs.mkdirSync(path.join(dir, 'skills', dirName), { recursive: true });
        fs.writeFileSync(path.join(dir, 'skills', dirName, 'SKILL.md'), `---\nname: ${fmName}\ndescription: test\n---\nbody\n`);
      }
      return dir;
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };

  // default fixtures: alpha (server + skill), beta (url server), gamma (skills only), delta (Claude Code only)
  env.addPlugin('alpha', { servers: { 'alpha-srv': { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/x.js'], env: { K: '${CLAUDE_PLUGIN_ROOT}/v' } } }, skills: ['alpha-skill'] });
  env.addPlugin('beta', { servers: { 'beta-srv': { url: 'https://example.com/${CLAUDE_PLUGIN_ROOT}' } } });
  env.addPlugin('gamma', { skills: ['gamma-one', 'gamma-two'] });
  env.addPlugin('delta', { servers: { 'delta-srv': { command: 'node' } }, skills: ['delta-skill'], doNotMigrate: true });
  return env;
}

export const ALL = ['codex', 'opencode', 'vscode'];
