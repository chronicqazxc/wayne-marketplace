import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeEnv, ALL } from './harness.mjs';
import { AdapterError, parseSelection, createAdapter } from '../core.mjs';

let env;
beforeEach(() => { env = makeEnv(); });
afterEach(() => env.cleanup());

describe('discover', () => {
  it('finds plugins with servers or skills, sorted, and skips Claude Code only plugins', () => {
    const { plugins, warnings } = env.adapter().discover();
    assert.deepEqual(plugins.map((p) => p.name), ['alpha', 'beta', 'gamma']);
    assert.deepEqual(warnings, []);
  });
  it('replaces ${CLAUDE_PLUGIN_ROOT} in args, env and url, and sets CLAUDE_PLUGIN_ROOT', () => {
    const { plugins } = env.adapter().discover();
    const a = plugins[0].servers[0]; const dir = env.p('plugins', 'alpha');
    assert.deepEqual(a.cmd, ['node', `${dir}/x.js`]);
    assert.equal(a.env.K, `${dir}/v`); assert.equal(a.env.CLAUDE_PLUGIN_ROOT, dir);
    assert.equal(plugins[1].servers[0].url, `https://example.com/${plugins[1].servers[0].env.CLAUDE_PLUGIN_ROOT}`);
  });
  it('skips a skill whose name differs from its folder, with a warning', () => {
    env.addPlugin('omega', { skills: [['dir-a', 'name-b']] });
    const d = env.adapter().discover();
    assert.ok(!d.plugins.some((p) => p.name === 'omega'));
    assert.match(d.warnings.join('\n'), /skip skill omega\/dir-a/);
  });
  it('skips a skill name that is not kebab-case (underscore, upper case, double hyphen)', () => {
    env.addPlugin('omega', { skills: ['bad_name', 'Bad', 'a--b', '-a'] });
    assert.equal(env.adapter().discover().warnings.length, 4);
  });
  it('skips a duplicate skill name from a later plugin', () => {
    env.addPlugin('omega', { skills: ['alpha-skill', 'omega-own'] });
    const d = env.adapter().discover();
    assert.deepEqual(d.plugins.find((p) => p.name === 'omega').skills.map((s) => s.name), ['omega-own']);
    assert.match(d.warnings.join('\n'), /duplicate skill name alpha-skill/);
  });
  it('skips a plugin with an invalid plugin.json, with a warning, and does not crash', () => {
    env.addPlugin('omega', { rawManifest: '{ not json', skills: ['omega-one'] });
    const d = env.adapter().discover();
    assert.ok(!d.plugins.some((p) => p.name === 'omega'));
    assert.match(d.warnings.join('\n'), /skip plugin omega/);
  });
  it('skips an MCP server with neither command nor url', () => {
    env.addPlugin('omega', { servers: { bad: {}, good: { command: 'x' } } });
    const d = env.adapter().discover();
    assert.deepEqual(d.plugins.find((p) => p.name === 'omega').servers.map((s) => s.name), ['good']);
    assert.match(d.warnings.join('\n'), /omega\/bad/);
  });
  it('skips an MCP server that is null', () => {
    env.addPlugin('omega', { rawManifest: '{"mcpServers":{"x":null,"y":{"command":"c"}}}' });
    assert.equal(env.adapter().discover().plugins.find((p) => p.name === 'omega').servers.length, 1);
  });
  it('ignores a plugin folder without plugin.json and a stray file in plugins/', () => {
    env.addPlugin('omega', { noManifest: true, skills: ['omega-one'] });
    fs.writeFileSync(env.p('plugins', '.DS_Store'), '');
    assert.deepEqual(env.adapter().discover().plugins.map((p) => p.name), ['alpha', 'beta', 'gamma']);
  });
  it('ignores a plugin that has no servers and no skills (for example commands only)', () => {
    env.addPlugin('omega', {});
    assert.ok(!env.adapter().discover().plugins.some((p) => p.name === 'omega'));
  });
  it('ignores a file inside skills/ and a skill folder without SKILL.md', () => {
    const dir = env.addPlugin('omega', { skills: ['omega-one'] });
    fs.writeFileSync(path.join(dir, 'skills', 'README.md'), 'x');
    fs.mkdirSync(path.join(dir, 'skills', 'empty'));
    assert.deepEqual(env.adapter().discover().plugins.find((p) => p.name === 'omega').skills.map((s) => s.name), ['omega-one']);
  });
  it('a SKILL.md without a name field is skipped', () => {
    const dir = env.addPlugin('omega', {});
    fs.mkdirSync(path.join(dir, 'skills', 'noname'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', 'noname', 'SKILL.md'), '---\ndescription: x\n---\n');
    assert.match(env.adapter().discover().warnings.join('\n'), /omega\/noname/);
  });
  it('the result is cached', () => { const ad = env.adapter(); assert.equal(ad.discover(), ad.discover()); });
});

describe('state file', () => {
  it('works without a state file', () => assert.doesNotThrow(() => env.adapter()));
  it('a state file that is not JSON is an error that names the file', () => {
    fs.mkdirSync(path.dirname(env.cfg.stateFile), { recursive: true }); fs.writeFileSync(env.cfg.stateFile, '{ nope');
    assert.throws(() => env.adapter(), (e) => e instanceof AdapterError && e.message.includes(env.cfg.stateFile));
  });
  it('a state file that is an array, null or a number is an error', () => {
    fs.mkdirSync(path.dirname(env.cfg.stateFile), { recursive: true });
    for (const body of ['[]', 'null', '5', '"x"']) { fs.writeFileSync(env.cfg.stateFile, body); assert.throws(() => env.adapter(), AdapterError, body); }
  });
  it('an empty state file is an error and is never overwritten by a run', () => {
    fs.mkdirSync(path.dirname(env.cfg.stateFile), { recursive: true }); fs.writeFileSync(env.cfg.stateFile, '');
    assert.throws(() => env.adapter(), AdapterError);
    assert.equal(fs.readFileSync(env.cfg.stateFile, 'utf8'), '');
  });
  it('reads the old format without "excluded"', () => {
    fs.mkdirSync(path.dirname(env.cfg.stateFile), { recursive: true });
    fs.writeFileSync(env.cfg.stateFile, JSON.stringify({ codex: ['alpha-srv'], skills: ['alpha-skill'] }));
    env.codexNames.add('alpha-srv');
    const rows = env.adapter().status(['codex']);
    assert.equal(rows.find((r) => r.name === 'alpha').state.codex.ownedAny, true);
  });
  it('treats a wrong type inside the state as empty', () => {
    fs.mkdirSync(path.dirname(env.cfg.stateFile), { recursive: true });
    fs.writeFileSync(env.cfg.stateFile, JSON.stringify({ codex: 'x', excluded: 'y', skills: { a: 1 } }));
    assert.doesNotThrow(() => env.sync());
  });
  it('is written after execute, with no temp file left', () => {
    env.sync();
    assert.ok(fs.existsSync(env.cfg.stateFile));
    assert.ok(!fs.existsSync(`${env.cfg.stateFile}.tmp`));
    assert.ok(env.state().codex.includes('alpha-srv'));
  });
  it('a plan does not write anything', () => {
    const snap = () => JSON.stringify([fs.readdirSync(env.root).sort(), [...env.codexNames], env.ocText(), fs.existsSync(env.cfg.stateFile)]);
    const before = snap();
    env.steps({ sync: true }); env.steps({ install: ['alpha'], update: [], uninstall: [] });
    assert.equal(snap(), before);
    assert.equal(env.calls.length, 0);
  });
  it('is saved even when a step throws', () => {
    fs.writeFileSync(env.p('agents'), 'a file, not a folder'); // skill links cannot be created
    env.sync(['codex']);
    assert.ok(env.state().codex.includes('alpha-srv'));
    assert.match(env.logs.join('\n'), /alpha-skill failed/);
  });
  it('is shared between two adapter objects through the file', () => {
    env.sync();
    assert.deepEqual(env.steps({ sync: true }), []);
  });
});

describe('usableTools', () => {
  it('returns all found and working tools', () => assert.deepEqual(env.adapter().usableTools(ALL), { usable: ALL, messages: [] }));
  it('skips a tool that is not installed', () => {
    const r = env.adapter({ bins: { codex: null, opencode: 'opencode' } }).usableTools(ALL);
    assert.deepEqual(r.usable, ['opencode', 'vscode']); assert.match(r.messages[0], /Codex not installed/);
  });
  it('skips VS Code when its user folder does not exist', () => {
    const e2 = makeEnv({ vscodeDir: false });
    assert.deepEqual(e2.adapter().usableTools(ALL).usable, ['codex', 'opencode']); e2.cleanup();
  });
  it('skips Codex when "codex mcp list" fails', () => {
    env.fail.codexList = true;
    const r = env.adapter().usableTools(ALL);
    assert.deepEqual(r.usable, ['opencode', 'vscode']); assert.match(r.messages[0], /Codex.*skipped/);
  });
  it('skips OpenCode when its config cannot be read', () => {
    env.fail.opencodeList = true;
    assert.deepEqual(env.adapter().usableTools(ALL).usable, ['codex', 'vscode']);
  });
  it('skips OpenCode when the command prints something that is not JSON', () => {
    env.fail.opencodeGarbage = true;
    assert.deepEqual(env.adapter().usableTools(ALL).usable, ['codex', 'vscode']);
  });
  it('skips VS Code when mcp.json is not valid, and never rewrites that file', () => {
    fs.writeFileSync(env.cfg.vscodeMcp, '{ broken');
    const r = env.adapter().usableTools(ALL);
    assert.deepEqual(r.usable, ['codex', 'opencode']); assert.match(r.messages[0], /VS Code.*not valid/);
    env.sync(['codex', 'opencode']);
    assert.equal(fs.readFileSync(env.cfg.vscodeMcp, 'utf8'), '{ broken');
  });
  it('skips VS Code when "servers" is an array or a string', () => {
    for (const body of ['{"servers":[]}', '{"servers":"x"}', '[]', 'null']) {
      fs.writeFileSync(env.cfg.vscodeMcp, body);
      assert.deepEqual(env.adapter().usableTools(['vscode']).usable, [], body);
    }
  });
  it('accepts a VS Code mcp.json with comments and a trailing comma', () => {
    fs.writeFileSync(env.cfg.vscodeMcp, '{\n // mine\n "servers": { "user": { "type": "http", "url": "http://x" }, },\n}');
    assert.deepEqual(env.adapter().usableTools(['vscode']).usable, ['vscode']);
  });
  it('accepts an empty VS Code mcp.json object', () => {
    fs.writeFileSync(env.cfg.vscodeMcp, '{}');
    assert.deepEqual(env.adapter().usableTools(['vscode']).usable, ['vscode']);
  });
  it('an unexpected error (not AdapterError) is not hidden', () => {
    const ad = createAdapter({ ...env.cfg, run: () => { throw new TypeError('bug'); } });
    assert.throws(() => ad.usableTools(['codex']), TypeError);
  });
});

describe('status', () => {
  it('shows none before any install, and only install is possible', () => {
    const r = env.adapter().status(ALL).find((x) => x.name === 'alpha');
    for (const t of ALL) assert.equal(r.state[t].state, 'none');
    assert.deepEqual(r.can, { install: true, update: false, uninstall: false });
  });
  it('lists plugins in order with the rule last and 1-based numbers', () => {
    const rows = env.adapter().status(ALL);
    assert.deepEqual(rows.map((r) => r.name), ['alpha', 'beta', 'gamma', 'root-rule']);
    assert.deepEqual(rows.map((r) => r.index), [1, 2, 3, 4]);
    assert.equal(rows[3].kind, 'rule');
  });
  it('shows installed after a sync, and update and uninstall are possible', () => {
    env.sync();
    for (const r of env.adapter().status(ALL)) { for (const t of ALL) assert.equal(r.state[t].state, 'installed', r.name); assert.deepEqual(r.can, { install: false, update: true, uninstall: true }); }
  });
  it('shows partial when a shared skill link is missing', () => {
    env.sync(); fs.unlinkSync(env.link('alpha-skill'));
    const r = env.adapter().status(ALL).find((x) => x.name === 'alpha');
    for (const t of ALL) assert.equal(r.state[t].state, 'partial');
    assert.equal(r.can.install, true);
  });
  it('shows partial when a server is missing in one tool only', () => {
    env.sync(); env.codexNames.delete('beta-srv');
    const r = env.adapter().status(ALL).find((x) => x.name === 'beta');
    assert.deepEqual(ALL.map((t) => r.state[t].state), ['none', 'installed', 'installed']);
  });
  it('shows external when the user installed it, and the adapter cannot uninstall it', () => {
    env.codexNames.add('beta-srv');
    const r = env.adapter().status(['codex']).find((x) => x.name === 'beta');
    assert.equal(r.state.codex.state, 'installed'); assert.equal(r.state.codex.external, true);
    assert.deepEqual(r.can, { install: false, update: false, uninstall: false });
  });
  it('shows excluded after an uninstall', () => {
    env.sync(); env.apply({ install: [], update: [], uninstall: ['beta'] });
    assert.equal(env.adapter().status(ALL).find((x) => x.name === 'beta').state.codex.excluded, true);
  });
  it('shows only the chosen tools', () => assert.deepEqual(Object.keys(env.adapter().status(['vscode'])[0].state), ['vscode']));
  it('counts skills and MCP servers', () => {
    const r = env.adapter().status(ALL);
    assert.deepEqual([r[0].skills, r[0].mcp, r[1].skills, r[1].mcp, r[2].skills, r[2].mcp], [1, 1, 0, 1, 2, 0]);
  });
  it('a dangling skill link counts as present', () => {
    fs.mkdirSync(env.cfg.skillsDir, { recursive: true });
    fs.symlinkSync('/nowhere/at/all', env.link('gamma-one'));
    assert.equal(env.adapter().status(['codex']).find((x) => x.name === 'gamma').state.codex.state, 'partial');
  });
});

describe('resolveRequest', () => {
  const r = (raw) => env.adapter().resolveRequest(raw);
  const names = (list) => list.map((e) => e.name);
  const e = (name, tools = null) => ({ name, tools });
  it('accepts names', () => assert.deepEqual(r({ install: ['alpha'], update: ['beta'], uninstall: ['gamma'] }), { install: [e('alpha')], update: [e('beta')], uninstall: [e('gamma')] }));
  it('accepts missing lists', () => assert.deepEqual(r({}), { install: [], update: [], uninstall: [] }));
  it('expands "all" for install, including the rule', () => assert.deepEqual(names(r({ install: ['all'] }).install), ['alpha', 'beta', 'gamma', 'root-rule']));
  it('expands "all" for update', () => assert.equal(r({ update: ['all'] }).update.length, 4));
  it('refuses "all" for uninstall', () => assert.throws(() => r({ uninstall: ['all'] }), /not allowed for uninstall/));
  it('refuses an unknown name and names it', () => assert.throws(() => r({ install: ['nope'] }), /Unknown plugin: nope/));
  it('refuses the same name in two lists', () => assert.throws(() => r({ install: ['alpha'], uninstall: ['alpha'] }), /more than one list/));
  it('refuses "all" in two lists', () => assert.throws(() => r({ install: ['all'], update: ['all'] }), /more than one list/));
  it('"all" skips a plugin that is named in another list', () => {
    const x = r({ install: ['all'], uninstall: ['alpha'] });
    assert.ok(!names(x.install).includes('alpha')); assert.deepEqual(names(x.uninstall), ['alpha']);
  });
  it('removes duplicates', () => assert.deepEqual(r({ install: ['alpha', 'alpha'] }).install, [e('alpha')]));
  it('"all" plus the same name is not a duplicate', () => assert.equal(r({ install: ['all', 'alpha'] }).install.length, 4));
  it('the rule is not known when the rule is off', () => {
    const ad = env.adapter({ includeRule: false });
    assert.throws(() => ad.resolveRequest({ install: ['root-rule'] }), /Unknown plugin/);
    assert.deepEqual(names(ad.resolveRequest({ install: ['all'] }).install), ['alpha', 'beta', 'gamma']);
  });
  describe('name@tool', () => {
    it('one tool', () => assert.deepEqual(r({ install: ['alpha@codex'] }).install, [e('alpha', ['codex'])]));
    it('several tools with +', () => assert.deepEqual(r({ install: ['alpha@codex+vscode'] }).install, [e('alpha', ['codex', 'vscode'])]));
    it('ignores case, spaces and duplicates in the tool list', () => assert.deepEqual(r({ install: ['alpha@Codex+ codex'] }).install, [e('alpha', ['codex'])]));
    it('"all@codex" applies to every plugin in Codex', () => {
      const x = r({ install: ['all@codex'] }).install;
      assert.equal(x.length, 4); assert.ok(x.every((y) => y.tools.length === 1 && y.tools[0] === 'codex'));
    });
    it('"all" skips a plugin that is named, whatever its tools', () => assert.ok(!names(r({ install: ['all@codex'], uninstall: ['alpha@vscode'] }).install).includes('alpha')));
    it('the same name for different tools in two lists is allowed', () => {
      const x = r({ install: ['alpha@codex'], uninstall: ['alpha@vscode'] });
      assert.deepEqual([x.install[0].tools, x.uninstall[0].tools], [['codex'], ['vscode']]);
    });
    it('the same name for the same tool in two lists is refused', () => assert.throws(() => r({ install: ['alpha@codex+vscode'], uninstall: ['alpha@vscode'] }), /more than one list/));
    it('"alpha" (all tools) and "alpha@codex" in two lists is refused', () => assert.throws(() => r({ install: ['alpha'], uninstall: ['alpha@codex'] }), /more than one list/));
    it('the same name twice in one list merges the tools', () => assert.deepEqual(r({ install: ['alpha@codex', 'alpha@vscode'] }).install, [e('alpha', ['codex', 'vscode'])]));
    it('a name with no tool in the same list as a name with tools means all tools', () => assert.deepEqual(r({ install: ['alpha@codex', 'alpha'] }).install, [e('alpha')]));
    it('an unknown tool is refused', () => assert.throws(() => r({ install: ['alpha@vim'] }), /Bad tool list/));
    it('an empty tool list is refused', () => assert.throws(() => r({ install: ['alpha@'] }), /Bad tool list/));
    it('"+" alone is refused', () => assert.throws(() => r({ install: ['alpha@+'] }), /Bad tool list/));
    it('an unknown plugin with a tool is refused', () => assert.throws(() => r({ install: ['nope@codex'] }), /Unknown plugin: nope/));
    it('"all@codex" is refused for uninstall', () => assert.throws(() => r({ uninstall: ['all@codex'] }), /not allowed/));
  });
});

describe('parseSelection', () => {
  let rows;
  beforeEach(() => { rows = env.adapter().status(ALL); });
  it('numbers', () => assert.deepEqual(parseSelection('1,3', 'install', rows).names, ['alpha', 'gamma']));
  it('names', () => assert.deepEqual(parseSelection('beta', 'install', rows).names, ['beta']));
  it('ranges', () => assert.deepEqual(parseSelection('1-3', 'install', rows).names, ['alpha', 'beta', 'gamma']));
  it('a reversed range', () => assert.deepEqual(parseSelection('3-1', 'install', rows).names, ['alpha', 'beta', 'gamma']));
  it('spaces and commas, extra separators', () => assert.deepEqual(parseSelection(' 1 ,, 2  3 ', 'install', rows).names, ['alpha', 'beta', 'gamma']));
  it('keeps "all" as a word for resolveRequest, in any case', () => assert.deepEqual(parseSelection('ALL', 'install', rows).names, ['all']));
  it('"all" once only', () => assert.deepEqual(parseSelection('all all', 'update', rows).names, ['all']));
  it('refuses "all" for uninstall with a warning', () => { const x = parseSelection('all', 'uninstall', rows); assert.deepEqual(x.names, []); assert.match(x.warnings[0], /not allowed/); });
  it('warns about an unknown number or name', () => {
    const x = parseSelection('99 foo', 'install', rows);
    assert.deepEqual(x.names, []); assert.equal(x.warnings.length, 2);
  });
  it('warns when the action is not possible, and skips that plugin', () => {
    const x = parseSelection('1', 'update', rows); // nothing is installed
    assert.deepEqual(x.names, []); assert.match(x.warnings[0], /alpha: cannot update/);
  });
  it('a range keeps the possible ones and warns for the others', () => {
    env.sync(['codex']); const r2 = env.adapter().status(ALL);
    const x = parseSelection('1-4', 'uninstall', r2);
    assert.equal(x.names.length, 4);
  });
  it('removes duplicates', () => assert.deepEqual(parseSelection('1 1 alpha', 'install', rows).names, ['alpha']));
  it('empty input = nothing', () => assert.deepEqual(parseSelection('   ', 'install', rows), { names: [], warnings: [] }));
  it('0 is unknown', () => assert.match(parseSelection('0', 'install', rows).warnings[0], /unknown/));
});
