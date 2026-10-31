import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeEnv } from './harness.mjs';
import { main, renderTable } from '../marketplace-adapter.mjs';

let env;
beforeEach(() => { env = makeEnv(); });
afterEach(() => env.cleanup());

async function cli(argv, { answers = [], isTTY = false, cfg = env.cfg } = {}) {
  const out = []; const err = []; const prompts = []; const queue = [...answers];
  const ask = async (q) => { prompts.push(q); if (!queue.length) throw new Error(`no answer left for: ${q}`); return queue.shift(); };
  const code = await main(argv, { cfg, out: (m) => out.push(m), err: (m) => err.push(m), isTTY, ask });
  return { code, out: out.join('\n'), err: err.join('\n'), prompts, left: queue.length };
}

describe('cli: simple modes', () => {
  it('--help prints the usage', async () => { const r = await cli(['--help']); assert.equal(r.code, 0); assert.match(r.out, /Usage:/); });
  it('an unknown option exits with 2, prints the problem and the usage, and does nothing', async () => {
    const r = await cli(['--unistall', 'alpha']);
    assert.equal(r.code, 2); assert.match(r.err, /Unknown option: --unistall/); assert.match(r.err, /Usage:/); assert.equal(r.out, '');
    assert.equal(env.codexNames.size, 0); assert.ok(!fs.existsSync(env.cfg.stateFile));
  });
  it('--list prints the tools as JSON', async () => assert.deepEqual(JSON.parse((await cli(['--list'])).out), { codex: true, opencode: true, vscode: true }));
  it('--list shows a missing tool', async () => {
    const r = await cli(['--list'], { cfg: { ...env.cfg, bins: { codex: null, opencode: 'opencode' } } });
    assert.equal(JSON.parse(r.out).codex, false);
  });
  it('--status prints the table', async () => {
    const r = await cli(['--status']);
    assert.equal(r.code, 0); assert.match(r.out, /status; tools: codex,opencode,vscode/); assert.match(r.out, /alpha\s+\[ \]\s+\[ \]\s+\[ \]/); assert.match(r.out, /root-rule/);
  });
  it('--status --json prints clean JSON on stdout and warnings on stderr', async () => {
    env.addPlugin('omega', { skills: ['bad_name'] });
    const r = await cli(['--status', '--json']);
    const j = JSON.parse(r.out); assert.deepEqual(j.tools, ['codex', 'opencode', 'vscode']); assert.equal(j.rows.length, 4);
    assert.match(r.err, /skip skill omega\/bad_name/);
  });
  it('--status does not write anything', async () => { await cli(['--status']); assert.ok(!fs.existsSync(env.cfg.stateFile)); assert.equal(env.calls.length, 0); });
  it('--status --ide codex shows one column', async () => { const j = JSON.parse((await cli(['--status', '--json', '--ide', 'codex'])).out); assert.deepEqual(j.tools, ['codex']); });
  it('renders [v], [~], [ ] and [u]', () => {
    const st = (state, external = false) => ({ state, external });
    const t = renderTable([{ index: 1, name: 'p', kind: 'plugin', skills: 1, mcp: 1, state: { codex: st('installed'), opencode: st('partial'), vscode: st('none') } },
      { index: 2, name: 'q', kind: 'plugin', skills: 0, mcp: 1, state: { codex: st('installed', true), opencode: st('none'), vscode: st('none') } }], ['codex', 'opencode', 'vscode']);
    assert.match(t, /p\s+\[v\]\s+\[~\]\s+\[ \]\s+1 skill, 1 MCP/); assert.match(t, /q\s+\[u\]/);
  });
});

describe('cli: plain run', () => {
  it('installs everything, then says up to date', async () => {
    const r1 = await cli([]); assert.equal(r1.code, 0); assert.match(r1.out, /13 item\(s\) changed/);
    assert.ok(env.codexNames.has('alpha-srv'));
    const r2 = await cli([]); assert.match(r2.out, /up to date/);
  });
  it('--yes in a terminal is the same, with no question', async () => {
    const r = await cli(['--yes'], { isTTY: true }); assert.equal(r.prompts.length, 0); assert.match(r.out, /changed/);
  });
  it('--dry-run shows the plan and changes nothing', async () => {
    const r = await cli(['--dry-run']);
    assert.match(r.out, /\+ codex: alpha-srv \(install\)/); assert.match(r.out, /13 item\(s\) would change/);
    assert.equal(env.codexNames.size, 0); assert.ok(!fs.existsSync(env.cfg.stateFile)); assert.ok(!env.isLink(env.link('alpha-skill')));
  });
  it('--check exits 1 when something would change, and 0 when not', async () => {
    assert.equal((await cli(['--check'])).code, 1); assert.equal(env.codexNames.size, 0);
    await cli([]); assert.equal((await cli(['--check'])).code, 0);
  });
  it('--force installs again what the user removed', async () => {
    await cli([]); env.codexNames.delete('alpha-srv');
    await cli([]); assert.ok(!env.codexNames.has('alpha-srv'));
    await cli(['--force']); assert.ok(env.codexNames.has('alpha-srv'));
  });
  it('--ide limits the tools', async () => { await cli(['--ide', 'vscode']); assert.equal(env.codexNames.size, 0); assert.ok(env.vscodeServers()['alpha-srv']); });
  it('--no-plugin-root-rule skips the rule', async () => {
    await cli(['--no-plugin-root-rule']); assert.ok(!fs.existsSync(env.cfg.codexAgents)); assert.ok(env.codexNames.has('alpha-srv'));
  });
  it('prints warnings about skipped skills', async () => {
    env.addPlugin('omega', { skills: [['dir-a', 'name-b']] });
    assert.match((await cli(['--dry-run'])).out, /skip skill omega\/dir-a/);
  });
  it('says so when no tool is installed', async () => {
    const e2 = makeEnv({ vscodeDir: false });
    const r = await cli([], { cfg: { ...e2.cfg, bins: { codex: null, opencode: null } } });
    assert.equal(r.code, 0); assert.match(r.out, /No supported tool found/); assert.ok(!fs.existsSync(e2.cfg.stateFile)); e2.cleanup();
  });
  it('a tool that cannot be read is skipped, the others run', async () => {
    env.fail.codexList = true;
    const r = await cli([]); assert.match(r.out, /Codex.*skipped/); assert.ok(env.vscodeServers()['alpha-srv']);
    assert.ok(!(env.state().codex || []).includes('alpha-srv'));
  });
  it('a state file that is not valid exits with 1, names the file, and keeps it', async () => {
    fs.mkdirSync(path.dirname(env.cfg.stateFile), { recursive: true }); fs.writeFileSync(env.cfg.stateFile, '{ nope');
    const r = await cli([]); assert.equal(r.code, 1); assert.match(r.err, /State file is not valid JSON/);
    assert.equal(fs.readFileSync(env.cfg.stateFile, 'utf8'), '{ nope'); assert.equal(env.codexNames.size, 0);
  });
});

describe('cli: explicit actions', () => {
  it('--install a plugin in one tool', async () => {
    const r = await cli(['--install', 'alpha', '--ide', 'codex']);
    assert.equal(r.code, 0); assert.ok(env.codexNames.has('alpha-srv')); assert.ok(!env.ocText().includes('alpha-srv')); assert.match(r.out, /changed/);
  });
  it('--install all', async () => { await cli(['--install', 'all']); assert.ok(env.codexNames.has('beta-srv') && fs.existsSync(env.cfg.vscodeRuleFile)); });
  it('--install all with --no-plugin-root-rule does not install the rule', async () => {
    await cli(['--install', 'all', '--no-plugin-root-rule']); assert.ok(!fs.existsSync(env.cfg.vscodeRuleFile)); assert.ok(env.codexNames.has('beta-srv'));
  });
  it('--uninstall removes only that plugin', async () => {
    await cli([]); const r = await cli(['--uninstall', 'alpha']);
    assert.equal(r.code, 0); assert.ok(!env.codexNames.has('alpha-srv') && env.codexNames.has('beta-srv'));
  });
  it('--update prints the update step', async () => {
    await cli([]); const r = await cli(['--update', 'beta', '--ide', 'codex']);
    assert.match(r.out, /~ codex: beta-srv \(update\)/);
  });
  it('--dry-run with an action changes nothing and shows the plan', async () => {
    await cli([]); const r = await cli(['--dry-run', '--uninstall', 'alpha']);
    assert.match(r.out, /- codex: alpha-srv \(uninstall\)/); assert.match(r.out, /would change/); assert.ok(env.codexNames.has('alpha-srv'));
  });
  it('--check with an action exits 1 when something would change', async () => {
    await cli([]); assert.equal((await cli(['--check', '--uninstall', 'alpha'])).code, 1);
    assert.equal((await cli(['--check', '--install', 'alpha'])).code, 0);
  });
  it('an unknown plugin exits with 2 and changes nothing', async () => {
    const r = await cli(['--install', 'alpha,nope']); assert.equal(r.code, 2); assert.match(r.err, /Unknown plugin: nope/); assert.equal(env.codexNames.size, 0);
  });
  it('the same plugin in two lists exits with 2', async () => {
    const r = await cli(['--install', 'alpha', '--uninstall', 'alpha']); assert.equal(r.code, 2); assert.match(r.err, /more than one list/);
  });
  it('--uninstall all exits with 2', async () => {
    await cli([]); const r = await cli(['--uninstall', 'all']); assert.equal(r.code, 2); assert.ok(env.codexNames.has('alpha-srv'));
  });
  it('--uninstall with a typo in the name does nothing', async () => {
    await cli([]); const r = await cli(['--uninstall', 'alpa']); assert.equal(r.code, 2); assert.ok(env.codexNames.has('alpha-srv'));
  });
  it('says "up to date" when nothing changes', async () => { await cli(['--install', 'alpha']); assert.match((await cli(['--install', 'alpha'])).out, /up to date/); });
});

describe('cli: name@tool', () => {
  it('--install alpha@codex installs in Codex only', async () => {
    const r = await cli(['--install', 'alpha@codex']); assert.equal(r.code, 0);
    assert.ok(env.codexNames.has('alpha-srv') && !env.vscodeServers()['alpha-srv'] && !env.ocText().includes('alpha-srv'));
  });
  it('one command with different tools for different plugins', async () => {
    await cli([]); const r = await cli(['--uninstall', 'alpha@codex+opencode,beta@vscode']);
    assert.equal(r.code, 0); assert.ok(!env.codexNames.has('alpha-srv') && env.vscodeServers()['alpha-srv'] && !env.vscodeServers()['beta-srv'] && env.codexNames.has('beta-srv'));
  });
  it('an unknown tool exits with 2 and changes nothing', async () => {
    const r = await cli(['--install', 'alpha@vim']); assert.equal(r.code, 2); assert.match(r.err, /Bad tool list/); assert.equal(env.codexNames.size, 0);
  });
  it('a tool that is not available exits with 2 and changes nothing', async () => {
    const r = await cli(['--install', 'alpha@codex', '--ide', 'vscode']); assert.equal(r.code, 2); assert.match(r.err, /alpha@codex: Codex is not available/);
    assert.equal(env.codexNames.size, 0); assert.ok(!env.vscodeServers()['alpha-srv']);
  });
  it('--dry-run shows only the named tools', async () => {
    const r = await cli(['--dry-run', '--install', 'beta@vscode']); assert.match(r.out, /\+ vscode: beta-srv/); assert.ok(!/codex: beta-srv/.test(r.out));
  });
});

describe('cli: interactive', () => {
  it('asks the tool, then the plugins, shows the plan, asks to confirm, and applies', async () => {
    const r = await cli([], { isTTY: true, answers: ['1', '1', '', '', 'y'] });
    assert.equal(r.code, 0); assert.equal(r.prompts.length, 5); assert.equal(r.left, 0);
    assert.match(r.out, /Step 1/); assert.match(r.out, /Step 2/); assert.match(r.out, /Plan:/); assert.match(r.out, /\+ codex: alpha-srv \(install\)/);
    assert.ok(env.codexNames.has('alpha-srv')); assert.ok(!env.ocText().includes('alpha-srv'));
    assert.ok(env.state().codex.includes('alpha-srv'));
  });
  it('an empty answer to question 1 means all tools', async () => {
    await cli(['--interactive'], { answers: ['', '1', '', '', 'y'] });
    assert.ok(env.codexNames.has('alpha-srv') && env.vscodeServers()['alpha-srv'] && env.ocText().includes('alpha-srv'));
  });
  it('"all" for question 1 means all tools', async () => {
    await cli(['--interactive'], { answers: ['all', '1', '', '', 'y'] }); assert.ok(env.vscodeServers()['alpha-srv']);
  });
  it('--ide skips question 1', async () => {
    const r = await cli(['--interactive', '--ide', 'vscode'], { answers: ['1', '', '', 'y'] });
    assert.equal(r.prompts.length, 4); assert.ok(env.vscodeServers()['alpha-srv']); assert.equal(env.codexNames.size, 0);
  });
  it('a wrong tool number is ignored; no valid tool means stop', async () => {
    const r = await cli(['--interactive'], { answers: ['9'] });
    assert.match(r.out, /No tool chosen/); assert.equal(r.code, 0); assert.equal(r.prompts.length, 1);
  });
  it('a mix of valid and wrong tool numbers uses the valid ones', async () => {
    await cli(['--interactive'], { answers: ['9,2', '1', '', '', 'y'] });
    assert.ok(env.ocText().includes('alpha-srv')); assert.equal(env.codexNames.size, 0);
  });
  it('"n" cancels and changes nothing', async () => {
    const r = await cli(['--interactive'], { answers: ['', '1-3', '', '', 'n'] });
    assert.match(r.out, /Cancelled/); assert.equal(env.codexNames.size, 0); assert.ok(!fs.existsSync(env.cfg.stateFile));
  });
  it('an empty answer to the confirmation cancels', async () => {
    await cli(['--interactive'], { answers: ['', '1', '', '', ''] }); assert.equal(env.codexNames.size, 0);
  });
  it('"yes" and "Y" confirm', async () => {
    await cli(['--interactive', '--ide', 'codex'], { answers: ['1', '', '', 'YES'] }); assert.ok(env.codexNames.has('alpha-srv'));
    await cli(['--interactive', '--ide', 'codex'], { answers: ['2', '', '', 'Y'] }); assert.ok(env.codexNames.has('beta-srv'));
  });
  it('anything else (for example "maybe" or "yy") cancels', async () => {
    await cli(['--interactive', '--ide', 'codex'], { answers: ['1', '', '', 'maybe'] }); assert.equal(env.codexNames.size, 0);
  });
  it('nothing selected: no confirmation question', async () => {
    const r = await cli(['--interactive'], { answers: ['', '', '', ''] });
    assert.match(r.out, /Nothing to change/); assert.equal(r.prompts.length, 4);
  });
  it('a wrong plugin number is reported and the rest still works', async () => {
    const r = await cli(['--interactive', '--ide', 'codex'], { answers: ['99, 1', '', '', 'y'] });
    assert.match(r.out, /unknown plugin: 99/); assert.ok(env.codexNames.has('alpha-srv'));
  });
  it('"all" installs every plugin and the rule', async () => {
    await cli(['--interactive'], { answers: ['', 'all', '', '', 'y'] });
    assert.ok(env.codexNames.has('beta-srv') && env.isLink(env.link('gamma-two')) && fs.existsSync(env.cfg.vscodeRuleFile));
  });
  it('"all" for uninstall is refused with a message', async () => {
    await cli([]); const r = await cli(['--interactive'], { answers: ['', '', '', 'all'] });
    assert.match(r.out, /"all" is not allowed for uninstall/); assert.ok(env.codexNames.has('alpha-srv'));
  });
  it('uninstall by number works and shows the plan', async () => {
    await cli([]); const r = await cli(['--interactive'], { answers: ['', '', '', '1', 'y'] });
    assert.match(r.out, /- codex: alpha-srv \(uninstall\)/); assert.ok(!env.codexNames.has('alpha-srv') && !env.vscodeServers()['alpha-srv']);
  });
  it('the same plugin in update and uninstall stops with a message and changes nothing', async () => {
    await cli([]); const r = await cli(['--interactive'], { answers: ['', '', '1', '1'] });
    assert.match(r.out, /more than one list/); assert.match(r.out, /Nothing changed/); assert.equal(r.prompts.length, 4); assert.ok(env.codexNames.has('alpha-srv'));
  });
  it('"all" in install plus a named plugin in uninstall: the named one wins', async () => {
    await cli([]); await cli(['--uninstall', 'beta']);
    await cli(['--interactive', '--ide', 'codex'], { answers: ['all', '', '1', 'y'] });
    assert.ok(env.codexNames.has('beta-srv')); assert.ok(!env.codexNames.has('alpha-srv'));
  });
  it('a plugin that cannot be updated gives a warning, not a step', async () => {
    const r = await cli(['--interactive', '--ide', 'codex'], { answers: ['', '1', ''] });
    assert.match(r.out, /alpha: cannot update/);
  });
  it('after the apply, the next status shows the plugin as installed', async () => {
    await cli(['--interactive', '--ide', 'codex'], { answers: ['1', '', '', 'y'] });
    assert.match((await cli(['--status', '--ide', 'codex'])).out, /alpha\s+\[v\]/);
  });
  it('without a terminal and without --interactive there is no question', async () => {
    const r = await cli([], { isTTY: false, answers: [] }); assert.equal(r.prompts.length, 0);
  });
  it('a state error stops before any question', async () => {
    fs.mkdirSync(path.dirname(env.cfg.stateFile), { recursive: true }); fs.writeFileSync(env.cfg.stateFile, 'x');
    const r = await cli([], { isTTY: true, answers: [] }); assert.equal(r.code, 1); assert.equal(r.prompts.length, 0);
  });
  it('no tool installed: says so before any question', async () => {
    const e2 = makeEnv({ vscodeDir: false });
    const r = await cli(['--interactive'], { cfg: { ...e2.cfg, bins: { codex: null, opencode: null } }, answers: [] });
    assert.match(r.out, /No supported tool found/); assert.equal(r.prompts.length, 0); e2.cleanup();
  });
});
