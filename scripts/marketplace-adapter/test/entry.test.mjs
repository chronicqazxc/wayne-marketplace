import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildConfig } from '../marketplace-adapter.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'marketplace-adapter.mjs');
const runScript = (args, file = SCRIPT) => spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', env: { ...process.env, HOME: os.tmpdir() } });

describe('buildConfig', () => {
  it('uses the ADAPTER_* variables for every path', () => {
    const env = { PATH: '/x', ADAPTER_SKILLS_DIR: '/s/skills', ADAPTER_STATE_FILE: '/s/state.json', ADAPTER_VSCODE_MCP: '/s/mcp.json', ADAPTER_OPENCODE_CONFIG: '/s/oc.jsonc',
      ADAPTER_CODEX_AGENTS: '/s/c.md', ADAPTER_OPENCODE_AGENTS: '/s/o.md', ADAPTER_VSCODE_INSTRUCTIONS: '/s/v.md', OPENCODE_BIN: '/s/opencode' };
    const c = buildConfig(env);
    assert.equal(c.skillsDir, '/s/skills'); assert.equal(c.stateFile, '/s/state.json'); assert.equal(c.vscodeMcp, '/s/mcp.json'); assert.equal(c.opencodeConfig, '/s/oc.jsonc');
    assert.equal(c.codexAgents, '/s/c.md'); assert.equal(c.opencodeAgents, '/s/o.md'); assert.equal(c.vscodeRuleFile, '/s/v.md'); assert.equal(c.bins.opencode, '/s/opencode');
    assert.equal(c.ruleLink, '/s/marketplace-root.md'); // next to the skills folder
  });
  it('defaults to the folders in the home folder', () => {
    const c = buildConfig({ PATH: '' }); const home = os.homedir();
    assert.equal(c.skillsDir, path.join(home, '.agents', 'skills')); assert.equal(c.stateFile, path.join(home, '.marketplace-adapter', 'state.json'));
    assert.equal(c.codexAgents, path.join(home, '.codex', 'AGENTS.md')); assert.equal(c.ruleLink, path.join(home, '.agents', 'marketplace-root.md'));
    assert.equal(c.vscodeRuleFile, path.join(home, '.copilot', 'instructions', 'plugin-root.instructions.md'));
  });
  it('points to the rule file and the plugins folder inside the marketplace', () => {
    const c = buildConfig({}); assert.ok(fs.existsSync(c.ruleSrc)); assert.ok(fs.existsSync(c.pluginsDir));
  });
  it('the run function runs a real command', () => assert.equal(buildConfig({}).run(process.execPath, ['-e', 'console.log("hi")']).stdout.trim(), 'hi'));
});

describe('script as a process', () => {
  it('--help exits with 0', () => { const r = runScript(['--help']); assert.equal(r.status, 0); assert.match(r.stdout, /Usage:/); });
  it('a typo exits with 2 and prints the problem on stderr', () => {
    const r = runScript(['--unistall', 'x']); assert.equal(r.status, 2); assert.match(r.stderr, /Unknown option/); assert.equal(r.stdout, '');
  });
  it('starts when called through a symlink', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-link-')); const link = path.join(dir, 'adapter.mjs');
    fs.symlinkSync(SCRIPT, link);
    const r = runScript(['--help'], link); assert.equal(r.status, 0); assert.match(r.stdout, /Usage:/); fs.rmSync(dir, { recursive: true });
  });
  it('importing the file does not run it', async () => { await import('../marketplace-adapter.mjs'); assert.ok(true); });
});
