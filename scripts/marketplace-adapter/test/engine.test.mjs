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
const bak = (file) => fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith(`${path.basename(file)}.bak.`));
const nameOf = (s) => s.replace(/ \(.*\)$/, '');

describe('plain run (sync)', () => {
  it('on an empty machine installs every server, skill and the rule in all tools', () => {
    const steps = env.sync();
    assert.equal(env.changes(steps).length, 13); // 2 servers x 3 tools + 3 rule items + 3 skills + 1 rule link
    assert.deepEqual([...env.codexNames].sort(), ['alpha-srv', 'beta-srv']);
    assert.deepEqual(Object.keys(env.vscodeServers()).sort(), ['alpha-srv', 'beta-srv']);
    assert.ok(env.ocText().includes('"alpha-srv"') && env.ocText().includes('"beta-srv"'));
    for (const s of ['alpha-skill', 'gamma-one', 'gamma-two']) assert.ok(env.isLink(env.link(s)), s);
    assert.ok(env.isLink(env.cfg.ruleLink));
  });
  it('writes the state: owned items for each tool, skills, rule link', () => {
    env.sync(); const s = env.state();
    for (const t of ALL) assert.ok(s[t].includes('alpha-srv') || t === 'x');
    assert.deepEqual(s.skills.sort(), ['alpha-skill', 'gamma-one', 'gamma-two']);
    assert.deepEqual(s.rules, ['link']);
    assert.ok(s.codex.includes('plugin-root-rule'));
  });
  it('does not touch the user entries in OpenCode and VS Code', () => {
    fs.writeFileSync(env.cfg.vscodeMcp, '{"servers":{"mine":{"type":"http","url":"http://z"}},"other":1}');
    env.sync();
    assert.ok(env.vscodeServers().mine); assert.equal(JSON.parse(fs.readFileSync(env.cfg.vscodeMcp, 'utf8')).other, 1);
    assert.ok(env.ocText().includes('user-own-server') && env.ocText().includes('// my own comment'));
  });
  it('is idempotent: the second run has no step at all', () => { env.sync(); assert.deepEqual(env.steps({ sync: true }), []); });
  it('only the chosen tools are changed', () => {
    env.sync(['codex']);
    assert.equal(env.codexNames.size, 2); assert.deepEqual(env.vscodeServers(), {}); assert.ok(!env.ocText().includes('alpha-srv'));
  });
  it('skills are still linked when only one tool is chosen', () => { env.sync(['vscode']); assert.ok(env.isLink(env.link('alpha-skill'))); });
  it('respects a removal made by the user with the tool own command', () => {
    env.sync(); env.codexNames.delete('alpha-srv');
    const steps = env.steps({ sync: true });
    assert.deepEqual(env.changes(steps), []);
    assert.match(env.texts(steps).join('\n'), /codex: alpha-srv was removed by user/);
  });
  it('--force installs again what the user removed', () => {
    env.sync(); env.codexNames.delete('alpha-srv');
    env.sync(ALL, { force: true });
    assert.ok(env.codexNames.has('alpha-srv'));
  });
  it('--force also restores a removed skill link', () => {
    env.sync(); fs.unlinkSync(env.link('gamma-one'));
    assert.deepEqual(env.changes(env.steps({ sync: true })), []);
    env.sync(ALL, { force: true }); assert.ok(env.isLink(env.link('gamma-one')));
  });
  it('--force does not install what the user uninstalled with the adapter', () => {
    env.sync(); env.apply(req({ uninstall: ['beta'] }));
    assert.deepEqual(env.changes(env.steps({ sync: true }, ALL, { force: true })), []);
  });
  it('leaves an item alone that exists but was not created by the adapter', () => {
    env.codexNames.add('alpha-srv');
    const steps = env.steps({ sync: true }, ['codex']);
    assert.match(env.texts(steps).join('\n'), /codex: alpha-srv exists \(not created by adapter\)/);
    env.sync(['codex']);
    assert.ok(!env.state().codex.includes('alpha-srv'));
  });
  it('leaves a real skill folder of the user alone', () => {
    fs.mkdirSync(env.link('gamma-one'), { recursive: true }); fs.writeFileSync(path.join(env.link('gamma-one'), 'mine.txt'), 'x');
    env.sync();
    assert.ok(!env.isLink(env.link('gamma-one'))); assert.ok(fs.existsSync(path.join(env.link('gamma-one'), 'mine.txt')));
    assert.ok(!env.state().skills.includes('gamma-one'));
  });
  it('does not install a plugin that the user uninstalled', () => {
    env.sync(); env.apply(req({ uninstall: ['alpha'] }));
    assert.deepEqual(env.changes(env.steps({ sync: true })), []);
  });
  it('never rewrites an entry that exists, even if it differs (the user may have changed it)', () => {
    env.sync();
    const f = JSON.parse(fs.readFileSync(env.cfg.vscodeMcp, 'utf8')); f.servers['alpha-srv'].cwd = '/mine'; fs.writeFileSync(env.cfg.vscodeMcp, JSON.stringify(f));
    assert.deepEqual(env.sync(), []); assert.equal(env.vscodeServers()['alpha-srv'].cwd, '/mine');
  });
  it('warns, and does not rewrite, an entry that points to another folder', () => {
    env.sync();
    const file = env.p('oc', 'opencode.jsonc'); fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/("alpha-srv": \{[^}]*"command": \[)"node"/, '$1"/old/node"'));
    const notes = env.sync(['opencode']).filter((s) => s.kind === 'note').map((s) => s.text);
    assert.deepEqual(notes, ['! opencode: alpha-srv points to another folder — run update to repoint it']);
    assert.match(fs.readFileSync(file, 'utf8'), /\/old\/node/);
  });
  it('does not refresh a VS Code entry that the user created', () => {
    fs.writeFileSync(env.cfg.vscodeMcp, '{"servers":{"alpha-srv":{"type":"http","url":"http://mine"}}}');
    env.sync(['vscode']);
    assert.equal(env.vscodeServers()['alpha-srv'].url, 'http://mine');
  });
  it('repairs a skill link that points to an old place (marketplace moved)', () => {
    env.sync(); fs.unlinkSync(env.link('gamma-one')); fs.symlinkSync('/old/place/gamma-one', env.link('gamma-one'));
    const state = env.state(); assert.ok(state.skills.includes('gamma-one'));
    const steps = env.sync();
    assert.deepEqual(env.changes(steps), ['~ skills: gamma-one (update)']);
    assert.equal(fs.readlinkSync(env.link('gamma-one')), path.join(env.p('plugins', 'gamma', 'skills', 'gamma-one')));
  });
  it('does not repair a link that the user created', () => {
    fs.mkdirSync(env.cfg.skillsDir, { recursive: true }); fs.symlinkSync('/user/place', env.link('gamma-one'));
    env.sync(); assert.equal(fs.readlinkSync(env.link('gamma-one')), '/user/place');
  });
  it('a new plugin is installed in the next run', () => {
    env.sync(); env.addPlugin('omega', { servers: { 'omega-srv': { command: 'x' } } });
    assert.deepEqual(env.changes(env.sync()).length, 3);
    assert.ok(env.codexNames.has('omega-srv'));
  });
  it('a plugin that was deleted from the marketplace is not removed by a plain run', () => {
    env.sync(); fs.rmSync(env.p('plugins', 'beta'), { recursive: true });
    assert.deepEqual(env.steps({ sync: true }), []); assert.ok(env.codexNames.has('beta-srv'));
  });
  it('works with no tool at all', () => assert.deepEqual(env.steps({ sync: true }, []).filter((s) => s.kind !== 'note').map((s) => s.where), ['skills', 'skills', 'skills', 'rules']));
  it('a plugin that cannot be linked leaves the other steps running', () => {
    fs.writeFileSync(env.p('agents'), 'file'); // the skills folder cannot be created
    env.sync(['codex']);
    assert.ok(env.codexNames.has('alpha-srv'));
  });
});

describe('install', () => {
  it('installs the servers of a plugin and its shared skills, only in the chosen tool', () => {
    env.apply(req({ install: ['alpha'] }), ['codex']);
    assert.ok(env.codexNames.has('alpha-srv')); assert.ok(!env.ocText().includes('alpha-srv')); assert.ok(env.isLink(env.link('alpha-skill')));
    assert.ok(!env.codexNames.has('beta-srv'));
  });
  it('the second install changes nothing', () => {
    env.apply(req({ install: ['alpha'] }));
    assert.deepEqual(env.changes(env.steps(req({ install: ['alpha'] }))), []);
  });
  it('installs only in the tools that do not have it', () => {
    env.apply(req({ install: ['beta'] }), ['codex']);
    assert.deepEqual(env.changes(env.steps(req({ install: ['beta'] }))).map(nameOf), ['+ opencode: beta-srv', '+ vscode: beta-srv']);
  });
  it('installs again what the user removed (an explicit request is a force)', () => {
    env.sync(); env.codexNames.delete('beta-srv');
    env.apply(req({ install: ['beta'] })); assert.ok(env.codexNames.has('beta-srv'));
  });
  it('removes the uninstalled mark', () => {
    env.sync(); env.apply(req({ uninstall: ['beta'] }));
    assert.deepEqual(env.state().excluded.codex, ['beta']);
    env.apply(req({ install: ['beta'] }));
    assert.deepEqual(env.state().excluded.codex, []);
    assert.deepEqual(env.changes(env.steps({ sync: true })), []);
  });
  it('does not take over an item that the user installed', () => {
    env.codexNames.add('beta-srv');
    const steps = env.apply(req({ install: ['beta'] }), ['codex']);
    assert.deepEqual(env.changes(steps), []); assert.match(env.texts(steps).join('\n'), /exists \(not created by adapter\)/);
    assert.ok(!env.state().codex?.includes('beta-srv'));
  });
  it('a plugin with skills only is installed for all tools, whatever tool is chosen', () => {
    env.apply(req({ install: ['gamma'] }), ['codex']);
    assert.ok(env.isLink(env.link('gamma-one')) && env.isLink(env.link('gamma-two')));
  });
  it('installs the same item once even if two plugins are in the request', () => {
    env.apply(req({ install: ['alpha', 'beta'] }), ['codex']);
    assert.deepEqual(env.calls, ['codex add alpha-srv', 'codex add beta-srv']);
  });
  it('a failed add is not recorded as owned and is tried again next time', () => {
    env.fail.codexAdd.add('alpha-srv');
    env.apply(req({ install: ['alpha'] }), ['codex']);
    assert.ok(!env.codexNames.has('alpha-srv')); assert.ok(!env.state().codex?.includes('alpha-srv'));
    assert.match(env.logs.join('\n'), /codex add alpha-srv failed: add refused/);
    env.fail.codexAdd.clear(); env.clearLogs();
    env.apply(req({ install: ['alpha'] }), ['codex']); assert.ok(env.codexNames.has('alpha-srv'));
  });
  it('a failed add in one tool does not stop the other tools', () => {
    env.fail.codexAdd.add('beta-srv');
    env.apply(req({ install: ['beta'] }));
    assert.ok(!env.codexNames.has('beta-srv')); assert.ok(env.vscodeServers()['beta-srv']); assert.ok(env.ocText().includes('beta-srv'));
  });
  it('the OpenCode add keeps the comments of the user', () => {
    env.apply(req({ install: ['beta'] }), ['opencode']);
    assert.ok(env.ocText().includes('// my own comment') && env.ocText().includes('// servers comment'));
  });
  it('a missing skill source is reported and not recorded', () => {
    const ad = env.adapter(); const steps = ad.plan(req({ install: ['gamma'] }), ['codex']);
    fs.rmSync(env.p('plugins', 'gamma', 'skills'), { recursive: true });
    ad.execute(steps);
    assert.match(env.logs.join('\n'), /source missing/); assert.ok(!env.state().skills?.includes('gamma-one'));
  });
});

describe('update', () => {
  beforeEach(() => { env.sync(); env.clearLogs(); });
  it('removes and adds again in Codex', () => {
    const steps = env.apply(req({ update: ['beta'] }), ['codex']);
    assert.deepEqual(env.changes(steps), ['~ codex: beta-srv (update)']);
    assert.deepEqual(env.calls, ['codex remove beta-srv', 'codex add beta-srv']);
    assert.ok(env.codexNames.has('beta-srv')); assert.ok(env.state().codex.includes('beta-srv'));
  });
  it('removes and adds again in OpenCode and keeps the comments', () => {
    env.apply(req({ update: ['beta'] }), ['opencode']);
    assert.deepEqual(env.calls, ['opencode add beta-srv']);
    assert.ok(env.ocText().includes('beta-srv') && env.ocText().includes('// servers comment') && env.ocText().includes('user-own-server'));
    assert.equal(env.ocText().split('"beta-srv"').length - 1, 1);
  });
  it('in VS Code it changes only an entry that is out of date', () => {
    assert.deepEqual(env.changes(env.steps(req({ update: ['beta'] }), ['vscode'])), []);
    const f = JSON.parse(fs.readFileSync(env.cfg.vscodeMcp, 'utf8')); f.servers['beta-srv'].url = 'http://old'; fs.writeFileSync(env.cfg.vscodeMcp, JSON.stringify(f));
    env.apply(req({ update: ['beta'] }), ['vscode']);
    assert.notEqual(env.vscodeServers()['beta-srv'].url, 'http://old');
  });
  it('an explicit update does rewrite an entry that was changed, and keeps a backup of mcp.json', () => {
    const f = JSON.parse(fs.readFileSync(env.cfg.vscodeMcp, 'utf8')); f.servers['alpha-srv'].cwd = '/mine'; fs.writeFileSync(env.cfg.vscodeMcp, JSON.stringify(f));
    env.apply(req({ update: ['alpha'] }), ['vscode']);
    assert.notEqual(env.vscodeServers()['alpha-srv'].cwd, '/mine'); assert.ok(bak(env.cfg.vscodeMcp).length >= 1);
  });
  it('never installs: an item that is not installed gets a note', () => {
    env.codexNames.delete('beta-srv');
    const steps = env.apply(req({ update: ['beta'] }), ['codex']);
    assert.deepEqual(env.changes(steps), []); assert.match(env.texts(steps).join('\n'), /beta-srv is not installed — use install/);
    assert.ok(!env.codexNames.has('beta-srv'));
  });
  it('updates the tools that have it and only notes the others', () => {
    env.codexNames.delete('beta-srv');
    const steps = env.apply(req({ update: ['beta'] }));
    assert.equal(env.changes(steps).length, 1); // OpenCode only (VS Code entry is not out of date)
    assert.match(env.texts(steps).join('\n'), /codex: beta-srv is not installed/);
  });
  it('does not touch an item that the user installed', () => {
    fs.rmSync(env.cfg.stateFile); env.clearLogs();
    const steps = env.apply(req({ update: ['beta'] }), ['codex']);
    assert.deepEqual(env.changes(steps), []); assert.deepEqual(env.calls, []);
    assert.match(env.texts(steps).join('\n'), /codex: beta-srv installed by user — left alone/);
  });
  it('a failed add after the remove drops the ownership, so the next plain run installs it again', () => {
    env.fail.codexAdd.add('beta-srv');
    env.apply(req({ update: ['beta'] }), ['codex']);
    assert.ok(!env.codexNames.has('beta-srv')); assert.ok(!env.state().codex.includes('beta-srv'));
    env.fail.codexAdd.clear();
    env.sync(['codex']); assert.ok(env.codexNames.has('beta-srv'));
  });
  it('a failed remove keeps the item and the ownership', () => {
    env.fail.codexRemove.add('beta-srv');
    env.apply(req({ update: ['beta'] }), ['codex']);
    assert.ok(env.codexNames.has('beta-srv')); assert.ok(env.state().codex.includes('beta-srv'));
    assert.deepEqual(env.calls, ['codex remove beta-srv']);
  });
  it('repairs a skill link that points to an old place', () => {
    fs.unlinkSync(env.link('gamma-one')); fs.symlinkSync('/old/place/gamma-one', env.link('gamma-one'));
    const steps = env.apply(req({ update: ['gamma'] }), ['codex']);
    assert.deepEqual(env.changes(steps), ['~ skills: gamma-one (update)']);
    assert.ok(fs.existsSync(env.link('gamma-one')));
  });
  it('does not create a skill link that is missing', () => {
    fs.unlinkSync(env.link('gamma-one'));
    assert.deepEqual(env.changes(env.apply(req({ update: ['gamma'] }), ['codex'])), []);
    assert.ok(!env.isLink(env.link('gamma-one')));
  });
  it('does not change the uninstalled mark', () => {
    env.apply(req({ uninstall: ['beta'] })); env.apply(req({ update: ['beta'] }));
    assert.deepEqual(env.state().excluded.codex, ['beta']);
  });
  it('a plugin without changes gives no steps for a skills-only plugin', () => assert.deepEqual(env.changes(env.steps(req({ update: ['gamma'] }))), []));
});

describe('uninstall', () => {
  beforeEach(() => { env.sync(); env.clearLogs(); });
  it('removes the servers in all chosen tools and the shared skills', () => {
    const steps = env.apply(req({ uninstall: ['alpha'] }));
    assert.deepEqual(env.changes(steps).sort(), ['- codex: alpha-srv (uninstall)', '- opencode: alpha-srv (uninstall)', '- skills: alpha-skill (uninstall)', '- vscode: alpha-srv (uninstall)']);
    assert.ok(!env.codexNames.has('alpha-srv')); assert.ok(!env.vscodeServers()['alpha-srv']); assert.ok(!env.ocText().includes('alpha-srv'));
    assert.ok(!env.isLink(env.link('alpha-skill')));
  });
  it('keeps the other plugins', () => {
    env.apply(req({ uninstall: ['alpha'] }));
    assert.ok(env.codexNames.has('beta-srv')); assert.ok(env.isLink(env.link('gamma-one')));
  });
  it('keeps the comments and the entries of the user in OpenCode, and makes a backup', () => {
    env.apply(req({ uninstall: ['alpha'] }));
    assert.ok(env.ocText().includes('// my own comment') && env.ocText().includes('// servers comment') && env.ocText().includes('user-own-server') && env.ocText().includes('rai-code-mcphub'));
    assert.ok(bak(env.cfg.opencodeConfig).length >= 1);
  });
  it('keeps the entries of the user in VS Code, and makes a backup', () => {
    fs.writeFileSync(env.cfg.vscodeMcp, JSON.stringify({ servers: { ...env.vscodeServers(), mine: { type: 'http', url: 'http://m' } } }));
    env.apply(req({ uninstall: ['alpha'] }));
    assert.ok(env.vscodeServers().mine); assert.ok(bak(env.cfg.vscodeMcp).length >= 1);
  });
  it('removes the ownership and records the uninstall for each chosen tool', () => {
    env.apply(req({ uninstall: ['alpha'] }));
    const s = env.state();
    for (const t of ALL) { assert.ok(!s[t].includes('alpha-srv'), t); assert.deepEqual(s.excluded[t], ['alpha']); }
    assert.ok(!s.skills.includes('alpha-skill'));
  });
  it('does nothing for a plugin that is not installed, but records the uninstall', () => {
    env.apply(req({ uninstall: ['alpha'] })); env.clearLogs();
    const steps = env.apply(req({ uninstall: ['alpha'] }));
    assert.deepEqual(env.changes(steps), []); assert.deepEqual(env.calls, []);
  });
  it('never removes an item that the user installed', () => {
    fs.rmSync(env.cfg.stateFile);
    const steps = env.apply(req({ uninstall: ['beta'] }));
    assert.deepEqual(env.changes(steps), []); assert.ok(env.codexNames.has('beta-srv')); assert.ok(env.vscodeServers()['beta-srv']);
    assert.match(env.texts(steps).join('\n'), /codex: beta-srv installed by user — left alone/);
  });
  it('removes only the items the adapter created when the tools mix both kinds', () => {
    const s = env.state(); s.codex = s.codex.filter((x) => x !== 'beta-srv'); fs.writeFileSync(env.cfg.stateFile, JSON.stringify(s));
    env.apply(req({ uninstall: ['beta'] }));
    assert.ok(env.codexNames.has('beta-srv')); assert.ok(!env.vscodeServers()['beta-srv']);
  });
  it('for one tool: removes the server there, keeps the skills because other tools still use them', () => {
    const steps = env.apply(req({ uninstall: ['alpha'] }), ['codex']);
    assert.deepEqual(env.changes(steps), ['- codex: alpha-srv (uninstall)']);
    assert.ok(env.vscodeServers()['alpha-srv']); assert.ok(env.isLink(env.link('alpha-skill')));
    assert.deepEqual(env.state().excluded, { codex: ['alpha'] });
  });
  it('removes the shared skills when the last tool is uninstalled', () => {
    env.apply(req({ uninstall: ['alpha'] }), ['codex']);
    env.apply(req({ uninstall: ['alpha'] }), ['opencode']);
    assert.ok(env.isLink(env.link('alpha-skill')));
    env.apply(req({ uninstall: ['alpha'] }), ['vscode']);
    assert.ok(!env.isLink(env.link('alpha-skill')));
  });
  it('a plain run does not bring back a plugin that was uninstalled for one tool only', () => {
    env.apply(req({ uninstall: ['beta'] }), ['codex']);
    env.sync(); assert.ok(!env.codexNames.has('beta-srv')); assert.ok(env.vscodeServers()['beta-srv']);
  });
  it('a plugin with skills only is removed for all tools, whatever tool is chosen', () => {
    const steps = env.apply(req({ uninstall: ['gamma'] }), ['codex']);
    assert.deepEqual(env.changes(steps).sort(), ['- skills: gamma-one (uninstall)', '- skills: gamma-two (uninstall)']);
    assert.deepEqual(env.state().excluded.vscode, ['gamma']);
    env.sync(); assert.ok(!env.isLink(env.link('gamma-one')));
  });
  it('then install brings it back', () => {
    env.apply(req({ uninstall: ['alpha'] })); env.apply(req({ install: ['alpha'] }));
    assert.ok(env.codexNames.has('alpha-srv') && env.vscodeServers()['alpha-srv'] && env.isLink(env.link('alpha-skill')));
    assert.deepEqual(env.state().excluded.codex, []);
  });
  it('never deletes a real folder, even if it is in the state file by mistake', () => {
    fs.unlinkSync(env.link('gamma-one')); fs.mkdirSync(env.link('gamma-one')); fs.writeFileSync(path.join(env.link('gamma-one'), 'mine.txt'), 'x');
    env.clearLogs(); env.apply(req({ uninstall: ['gamma'] }));
    assert.ok(fs.existsSync(path.join(env.link('gamma-one'), 'mine.txt')));
    assert.match(env.logs.join('\n'), /gamma-one was not removed/); assert.ok(env.state().skills.includes('gamma-one'));
  });
  it('never deletes a skill link that the user created', () => {
    const s = env.state(); s.skills = s.skills.filter((x) => x !== 'gamma-one'); fs.writeFileSync(env.cfg.stateFile, JSON.stringify(s));
    env.apply(req({ uninstall: ['gamma'] })); assert.ok(env.isLink(env.link('gamma-one')));
  });
  it('a failed remove keeps the item and the ownership, and still records the uninstall', () => {
    env.fail.codexRemove.add('alpha-srv');
    env.apply(req({ uninstall: ['alpha'] }), ['codex']);
    assert.ok(env.codexNames.has('alpha-srv')); assert.ok(env.state().codex.includes('alpha-srv'));
    assert.match(env.logs.join('\n'), /codex remove alpha-srv failed: remove refused/);
    assert.deepEqual(env.state().excluded.codex, ['alpha']);
  });
  it('a failed remove in one tool does not stop the other tools', () => {
    env.fail.codexRemove.add('alpha-srv');
    env.apply(req({ uninstall: ['alpha'] }));
    assert.ok(!env.vscodeServers()['alpha-srv']); assert.ok(!env.ocText().includes('alpha-srv'));
  });
  it('OpenCode: a config that breaks after the plan: the step fails before any write, the ownership stays', () => {
    const ad = env.adapter(); const steps = ad.plan(req({ uninstall: ['alpha'] }), ['opencode']);
    const broken = '{"mcp":{"servers":{"alpha-srv":{"type":"local"';
    fs.writeFileSync(env.cfg.opencodeConfig, broken);
    ad.execute(steps);
    assert.match(env.logs.join('\n'), /alpha-srv failed/);
    assert.equal(env.ocText(), broken); assert.ok(env.state().opencode.includes('alpha-srv')); assert.equal(bak(env.cfg.opencodeConfig).length, 0);
  });
  it('OpenCode: an entry that cannot be removed safely is left, and reported', () => {
    // a comment between the entry and its comma: cutting the entry would break the file
    fs.writeFileSync(env.cfg.opencodeConfig, '{"mcp":{"servers":{"alpha-srv":{"x":1} // c\n,"b":{"y":2}}}}');
    const s = env.state(); fs.mkdirSync(path.dirname(env.cfg.stateFile), { recursive: true }); fs.writeFileSync(env.cfg.stateFile, JSON.stringify({ ...s, opencode: ['alpha-srv'] }));
    const before = env.ocText();
    env.apply(req({ uninstall: ['alpha'] }), ['opencode']);
    assert.match(env.logs.join('\n'), /cannot remove alpha-srv/); assert.equal(env.ocText(), before);
    assert.ok(env.state().opencode.includes('alpha-srv')); assert.equal(bak(env.cfg.opencodeConfig).length, 0);
  });
  it('OpenCode: a config path that does not exist is reported and nothing is lost', () => {
    const ad = env.adapter({ opencodeConfig: env.p('missing', 'opencode.jsonc') }); // the tool reports the server, but the adapter has the wrong path
    const steps = ad.plan(req({ uninstall: ['alpha'] }), ['opencode']); ad.execute(steps);
    assert.match(env.logs.join('\n'), /config not found/); assert.ok(env.state().opencode.includes('alpha-srv'));
  });
  it('OpenCode: the entry in the flat shape is removed too', () => {
    fs.writeFileSync(env.cfg.opencodeConfig, '{\n  "mcp": {\n    "alpha-srv": { "type": "local" },\n    "keep": { "type": "local" }\n  }\n}\n');
    env.apply(req({ uninstall: ['alpha'] }), ['opencode']);
    assert.ok(!env.ocText().includes('alpha-srv') && env.ocText().includes('"keep"'));
  });
});

describe('shared links across tools', () => {
  it('a tool that is found but not chosen still keeps the skills', () => {
    env.sync(); env.apply(req({ uninstall: ['alpha'] }), ['codex', 'opencode']);
    assert.ok(env.isLink(env.link('alpha-skill')));
  });
  it('a tool that is not installed does not keep the skills', () => {
    const e2 = makeEnv({ vscodeDir: false });
    const bins = { codex: 'codex', opencode: null };
    const ad = () => e2.adapter({ bins });
    let s = ad().plan({ sync: true }, ['codex']); ad().execute(s);
    s = ad().plan(req({ uninstall: ['alpha'] }), ['codex']); ad().execute(s);
    assert.ok(!e2.isLink(e2.link('alpha-skill'))); e2.cleanup();
  });
});

describe('plan details', () => {
  it('lines() returns the notes and the steps in order', () => {
    const ad = env.adapter(); const steps = ad.plan(req({ install: ['beta'] }), ['codex']);
    assert.deepEqual(ad.lines(steps), ['+ codex: beta-srv (install)']);
  });
  it('changeCount ignores notes and marks', () => {
    const ad = env.adapter(); env.codexNames.add('alpha-srv');
    const steps = ad.plan(req({ install: ['alpha'] }), ['codex']);
    assert.equal(ad.changeCount(steps), 1); // only the skill link
  });
  it('the order is uninstall, update, install', () => {
    env.sync();
    const kinds = env.steps(req({ uninstall: ['alpha'], update: ['beta'], install: ['gamma'] }), ['codex']).filter((s) => ['remove', 'update', 'add'].includes(s.kind)).map((s) => s.kind);
    assert.deepEqual(kinds, ['remove', 'update']); // alpha server leaves Codex, beta is updated, gamma is already installed
  });
  it('a request is applied in one process and read again in the next', () => {
    env.apply(req({ install: ['alpha'] }), ['codex']);
    // OpenCode and VS Code still want alpha, so only the Codex server is removed
    assert.deepEqual(env.changes(env.steps(req({ uninstall: ['alpha'] }), ['codex'])), ['- codex: alpha-srv (uninstall)']);
  });
});
