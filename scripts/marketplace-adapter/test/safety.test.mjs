// Tests for problems found in the code review: the machine changes between plan and execute, symlinks, atomic writes, name clashes.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeEnv, ALL } from './harness.mjs';

let env;
beforeEach(() => { env = makeEnv(); });
afterEach(() => env.cleanup());

const none = { install: [], update: [], uninstall: [] };
const req = (o) => ({ ...none, ...o });
const START = '<!-- >>> marketplace:plugin-root >>> -->';
const read = (f) => fs.readFileSync(f, 'utf8');
const bak = (file) => fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith(`${path.basename(file)}.bak.`));

describe('the machine changes between plan and execute', () => {
  it('rule block is gone before a remove: the file is not changed (it was corrupted by a bad slice before)', () => {
    env.sync(['codex']);
    const ad = env.adapter(); const steps = ad.plan(req({ uninstall: ['root-rule'] }), ['codex']);
    const plain = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAA\nBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\n';
    fs.writeFileSync(env.cfg.codexAgents, plain); ad.execute(steps);
    assert.equal(read(env.cfg.codexAgents), plain);
    assert.match(env.logs.join('\n'), /plugin-root-rule is gone already/); assert.ok(!env.state().codex.includes('plugin-root-rule'));
  });
  it('rule block is gone before an update: the file is not changed', () => {
    env.sync(['codex']);
    const ad = env.adapter(); const steps = ad.plan(req({ update: ['root-rule'] }), ['codex']);
    fs.writeFileSync(env.cfg.codexAgents, 'user text only\n'); ad.execute(steps);
    assert.equal(read(env.cfg.codexAgents), 'user text only\n');
  });
  it('the markers become broken before the step: nothing is written', () => {
    env.sync(['codex']);
    const ad = env.adapter(); const steps = ad.plan(req({ uninstall: ['root-rule'] }), ['codex']);
    const broken = `${START}\nmy words\n`; fs.writeFileSync(env.cfg.codexAgents, broken); ad.execute(steps);
    assert.equal(read(env.cfg.codexAgents), broken); assert.match(env.logs.join('\n'), /broken marketplace marker/);
  });
  it('a server appears before an add: it is left alone and not recorded as ours', () => {
    const ad = env.adapter(); const steps = ad.plan(req({ install: ['beta'] }), ['codex']);
    env.codexNames.add('beta-srv'); ad.execute(steps);
    assert.match(env.logs.join('\n'), /beta-srv appeared meanwhile/); assert.deepEqual(env.calls, []); assert.ok(!env.state().codex?.includes('beta-srv'));
  });
  it('a block appears before an add: it is left alone', () => {
    const ad = env.adapter(); const steps = ad.plan(req({ install: ['root-rule'] }), ['codex']);
    fs.mkdirSync(path.dirname(env.cfg.codexAgents), { recursive: true }); fs.writeFileSync(env.cfg.codexAgents, `${START}\nmine\n<!-- <<< marketplace:plugin-root <<< -->\n`);
    ad.execute(steps); assert.match(read(env.cfg.codexAgents), /mine/); assert.ok(!env.state().codex?.includes('plugin-root-rule'));
  });
  it('a server is removed by the user before a remove: no command runs and the ownership is cleared', () => {
    env.sync(['codex']); env.clearLogs();
    const ad = env.adapter(); const steps = ad.plan(req({ uninstall: ['beta'] }), ['codex']);
    env.codexNames.delete('beta-srv'); ad.execute(steps);
    assert.deepEqual(env.calls, []); assert.match(env.logs.join('\n'), /beta-srv is gone already/); assert.ok(!env.state().codex.includes('beta-srv'));
  });
  it('a server is removed before an update: it is not added again', () => {
    env.sync(['codex']); env.clearLogs();
    const ad = env.adapter(); const steps = ad.plan(req({ update: ['beta'] }), ['codex']);
    env.codexNames.delete('beta-srv'); ad.execute(steps);
    assert.deepEqual(env.calls, []); assert.ok(!env.codexNames.has('beta-srv'));
  });
  it('mcp.json is edited by someone else after the plan: that edit is kept', () => {
    const ad = env.adapter(); ad.usableTools(['vscode']);
    const steps = ad.plan(req({ install: ['alpha', 'beta'] }), ['vscode']);
    fs.writeFileSync(env.cfg.vscodeMcp, JSON.stringify({ servers: { added: { type: 'http', url: 'http://new' } } }));
    ad.execute(steps);
    assert.ok(env.vscodeServers().added); assert.ok(env.vscodeServers()['alpha-srv'] && env.vscodeServers()['beta-srv']);
  });
  it('mcp.json becomes invalid before the step: the step fails, the file is not overwritten', () => {
    const ad = env.adapter(); ad.usableTools(['vscode']); const steps = ad.plan(req({ install: ['beta'] }), ['vscode']);
    fs.writeFileSync(env.cfg.vscodeMcp, '{ broken'); ad.execute(steps);
    assert.equal(read(env.cfg.vscodeMcp), '{ broken'); assert.match(env.logs.join('\n'), /beta-srv failed/);
  });
  it('the state is saved after each step, not only at the end', () => {
    const ad = env.adapter(); const first = ad.plan(req({ install: ['beta'] }), ['codex']).filter((s) => s.kind === 'add');
    let seen;
    const spy = { kind: 'add', where: 'codex', text: '+ spy', item: { store: 'codex', id: 'spy', present: () => false, add() { seen = env.state().codex?.includes('beta-srv'); return true; } } };
    ad.execute([...first, spy]);
    assert.equal(seen, true);
  });
});

describe('symlinks', () => {
  const link = (p, target) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.symlinkSync(target, p); };
  it('an AGENTS.md that is a symlink survives an uninstall of its only block, and the real file is emptied', () => {
    const real = env.p('dotfiles', 'AGENTS.md'); fs.mkdirSync(path.dirname(real)); fs.writeFileSync(real, '');
    link(env.cfg.codexAgents, real);
    env.sync(['codex']); assert.ok(read(real).includes(START)); assert.ok(env.isLink(env.cfg.codexAgents));
    env.apply(req({ uninstall: ['root-rule'] }), ['codex']);
    assert.ok(env.isLink(env.cfg.codexAgents)); assert.equal(read(real).trim(), '');
  });
  it('the block is written through the symlink; the link stays', () => {
    const real = env.p('dotfiles', 'AGENTS.md'); fs.mkdirSync(path.dirname(real)); fs.writeFileSync(real, '# mine\n');
    link(env.cfg.codexAgents, real); env.sync(['codex']);
    assert.ok(env.isLink(env.cfg.codexAgents)); assert.ok(read(real).startsWith('# mine\n')); assert.ok(read(real).includes(START));
  });
  it('mcp.json as a symlink: changed through the link', () => {
    const real = env.p('dotfiles', 'mcp.json'); fs.mkdirSync(path.dirname(real)); fs.writeFileSync(real, '{"servers":{}}');
    fs.rmSync(env.cfg.vscodeMcp, { force: true }); fs.symlinkSync(real, env.cfg.vscodeMcp);
    env.apply(req({ install: ['beta'] }), ['vscode']);
    assert.ok(env.isLink(env.cfg.vscodeMcp)); assert.ok(JSON.parse(read(real)).servers['beta-srv']);
  });
  it('a skill link that the adapter made, and the user then pointed to another folder, is left alone', () => {
    env.sync(); fs.unlinkSync(env.link('gamma-one')); link(env.link('gamma-one'), '/users/own/folder');
    assert.ok(env.state().skills.includes('gamma-one'));
    env.clearLogs(); env.apply(req({ uninstall: ['gamma'] }));
    assert.equal(fs.readlinkSync(env.link('gamma-one')), '/users/own/folder'); assert.match(env.logs.join('\n'), /gamma-one was not removed/);
  });
  it('a plain run does not point it back', () => {
    env.sync(); fs.unlinkSync(env.link('gamma-one')); link(env.link('gamma-one'), '/users/own/folder');
    assert.deepEqual(env.changes(env.steps({ sync: true })), []);
  });
  it('an old marketplace path with the same skill name is still repaired', () => {
    env.sync(); fs.unlinkSync(env.link('gamma-one')); link(env.link('gamma-one'), '/old/marketplace/plugins/gamma/skills/gamma-one');
    assert.deepEqual(env.changes(env.steps({ sync: true })), ['~ skills: gamma-one (update)']);
  });
});

describe('atomic writes', () => {
  it('keeps the file mode of mcp.json (for example 600) and leaves no temp file', () => {
    fs.writeFileSync(env.cfg.vscodeMcp, '{"servers":{}}'); fs.chmodSync(env.cfg.vscodeMcp, 0o600);
    env.apply(req({ install: ['beta'] }), ['vscode']);
    assert.equal(fs.statSync(env.cfg.vscodeMcp).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(env.cfg.vscodeMcp)).filter((f) => f.includes('.tmp-')), []);
  });
  it('keeps the file mode of AGENTS.md', () => {
    fs.mkdirSync(path.dirname(env.cfg.codexAgents), { recursive: true }); fs.writeFileSync(env.cfg.codexAgents, 'x\n'); fs.chmodSync(env.cfg.codexAgents, 0o640);
    env.sync(['codex']); assert.equal(fs.statSync(env.cfg.codexAgents).mode & 0o777, 0o640);
  });
  it('keeps the file mode of opencode.jsonc after a remove', () => {
    env.sync(['opencode']); fs.chmodSync(env.cfg.opencodeConfig, 0o600);
    env.apply(req({ uninstall: ['beta'] }), ['opencode']);
    assert.equal(fs.statSync(env.cfg.opencodeConfig).mode & 0o777, 0o600);
  });
  it('the state file has no temp file left', () => { env.sync(); assert.deepEqual(fs.readdirSync(path.dirname(env.cfg.stateFile)), ['state.json']); });
});

describe('name clashes and odd folders', () => {
  it('two plugins with the same MCP server name: the second is skipped with a warning, and one add is planned', () => {
    env.addPlugin('omega', { servers: { 'alpha-srv': { command: 'x' }, 'omega-own': { command: 'y' } } });
    const ad = env.adapter();
    assert.match(ad.discover().warnings.join('\n'), /duplicate MCP server name alpha-srv \(omega\)/);
    const adds = ad.plan({ sync: true }, ['codex']).filter((s) => s.kind === 'add' && s.item.id === 'alpha-srv');
    assert.equal(adds.length, 1);
  });
  it('a dangling symlink in plugins/ does not stop the run', () => {
    fs.symlinkSync('/nowhere', env.p('plugins', 'dangling'));
    assert.deepEqual(env.adapter().discover().plugins.map((p) => p.name), ['alpha', 'beta', 'gamma']);
  });
  it('a symlink to a plugin folder works', () => {
    fs.mkdirSync(env.p('elsewhere')); env.addPlugin('real', { skills: ['real-one'] });
    fs.renameSync(env.p('plugins', 'real'), env.p('elsewhere', 'real')); fs.symlinkSync(env.p('elsewhere', 'real'), env.p('plugins', 'linked'));
    assert.ok(env.adapter().discover().plugins.some((p) => p.name === 'linked'));
  });
  it('OpenCode: a server name in both the flat and the nested shape is removed from both', () => {
    fs.writeFileSync(env.cfg.opencodeConfig, '{\n  "mcp": {\n    "beta-srv": { "type": "local" },\n    "servers": {\n      "beta-srv": { "type": "local" },\n      "keep": { "type": "local" }\n    }\n  }\n}\n');
    const state = { opencode: ['beta-srv'] }; fs.mkdirSync(path.dirname(env.cfg.stateFile), { recursive: true }); fs.writeFileSync(env.cfg.stateFile, JSON.stringify(state));
    env.apply(req({ uninstall: ['beta'] }), ['opencode']);
    assert.ok(!env.ocText().includes('beta-srv') && env.ocText().includes('keep'));
  });
  it('OpenCode: a backup is made before the config is changed', () => {
    env.sync(['opencode']); env.apply(req({ uninstall: ['beta'] }), ['opencode']);
    assert.equal(bak(env.cfg.opencodeConfig).length, 1);
  });
});

describe('name@tool in a plan', () => {
  it('installs only in the tools that are named', () => {
    env.apply(req({ install: [{ name: 'beta', tools: ['codex', 'vscode'] }] }));
    assert.ok(env.codexNames.has('beta-srv') && env.vscodeServers()['beta-srv'] && !env.ocText().includes('beta-srv'));
  });
  it('install in one tool and uninstall in another, in one request', () => {
    env.sync();
    env.apply(env.adapter().resolveRequest({ uninstall: ['alpha@codex'], install: [] }));
    env.apply(env.adapter().resolveRequest({ uninstall: ['beta@vscode'], update: ['alpha@opencode'] }));
    assert.ok(!env.codexNames.has('alpha-srv') && env.vscodeServers()['alpha-srv'] && env.codexNames.has('beta-srv') && !env.vscodeServers()['beta-srv']);
  });
  it('an uninstall for one tool records the exclusion for that tool only', () => {
    env.sync(); env.apply(env.adapter().resolveRequest({ uninstall: ['beta@codex'] }));
    assert.deepEqual(env.state().excluded, { codex: ['beta'] });
  });
  it('a tool that is not in the usable tools is an error, and nothing is changed', () => {
    const ad = env.adapter();
    assert.throws(() => ad.plan(ad.resolveRequest({ install: ['beta@vscode'] }), ['codex']), /beta@vscode: VS Code is not available/);
    assert.equal(env.codexNames.size, 0);
  });
  it('a skills-only plugin ignores the tool list: skills are shared', () => {
    env.apply(env.adapter().resolveRequest({ install: ['gamma@codex'] }));
    assert.ok(env.isLink(env.link('gamma-one')));
    env.apply(env.adapter().resolveRequest({ uninstall: ['gamma@codex'] }));
    assert.deepEqual(env.state().excluded.vscode, ['gamma']); assert.ok(!env.isLink(env.link('gamma-one')));
  });
  it('the order of the tools in the request does not matter', () => {
    const a = env.steps(env.adapter().resolveRequest({ install: ['beta@vscode+codex'] })).map((s) => s.text);
    const b = env.steps(env.adapter().resolveRequest({ install: ['beta@codex+vscode'] })).map((s) => s.text);
    assert.deepEqual(a.sort(), b.sort());
  });
});
