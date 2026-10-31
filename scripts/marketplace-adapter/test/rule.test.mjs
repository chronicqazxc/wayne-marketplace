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
const END = '<!-- <<< marketplace:plugin-root <<< -->';
const block = (link) => `${START}\nIf a skill uses \`\${CLAUDE_PLUGIN_ROOT}\`, read ${link} first.\n${END}`;
const read = (f) => fs.readFileSync(f, 'utf8');
const bak = (file) => (fs.existsSync(path.dirname(file)) ? fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith(`${path.basename(file)}.bak.`)) : []);
const codexFile = () => env.cfg.codexAgents;

describe('rule: add', () => {
  it('creates the file with the block when the file does not exist', () => {
    env.sync(['codex']);
    assert.equal(read(codexFile()), `${block(env.cfg.ruleLink)}\n`);
    assert.deepEqual(bak(codexFile()), []);
  });
  it('adds a blank line and the block after the text of the user, and keeps the text', () => {
    fs.mkdirSync(path.dirname(codexFile()), { recursive: true }); fs.writeFileSync(codexFile(), '# Mine\nBe brief.\n');
    env.sync(['codex']);
    assert.equal(read(codexFile()), `# Mine\nBe brief.\n\n${block(env.cfg.ruleLink)}\n`);
    assert.equal(bak(codexFile()).length, 1);
  });
  it('works when the text has no final line break', () => {
    fs.mkdirSync(path.dirname(codexFile()), { recursive: true }); fs.writeFileSync(codexFile(), 'x');
    env.sync(['codex']); assert.equal(read(codexFile()), `x\n\n${block(env.cfg.ruleLink)}\n`);
  });
  it('works when the text already ends with a blank line', () => {
    fs.mkdirSync(path.dirname(codexFile()), { recursive: true }); fs.writeFileSync(codexFile(), 'x\n\n');
    env.sync(['codex']); assert.equal(read(codexFile()), `x\n\n${block(env.cfg.ruleLink)}\n`);
  });
  it('works with an empty existing file', () => {
    fs.mkdirSync(path.dirname(codexFile()), { recursive: true }); fs.writeFileSync(codexFile(), '');
    env.sync(['codex']); assert.equal(read(codexFile()), `${block(env.cfg.ruleLink)}\n`);
  });
  it('creates the VS Code instruction file with front matter and the block', () => {
    env.sync(['vscode']);
    const t = read(env.cfg.vscodeRuleFile);
    assert.ok(t.startsWith('---\nname: plugin-root\n') && t.includes('applyTo: "**"') && t.includes(block(env.cfg.ruleLink)));
  });
  it('OpenCode uses its own AGENTS.md', () => { env.sync(['opencode']); assert.ok(read(env.cfg.opencodeAgents).includes(START)); assert.ok(!fs.existsSync(codexFile())); });
  it('links the rule file once for all tools', () => {
    env.sync();
    assert.equal(fs.readlinkSync(env.cfg.ruleLink), env.cfg.ruleSrc);
  });
  it('the second run changes nothing', () => { env.sync(); assert.deepEqual(env.steps({ sync: true }), []); });
  it('the rule is not managed when it is off', () => {
    const ad = env.adapter({ includeRule: false });
    ad.execute(ad.plan({ sync: true }, ALL));
    assert.ok(!fs.existsSync(codexFile())); assert.ok(!fs.existsSync(env.cfg.ruleLink));
  });
  it('does not take over a block that the user wrote', () => {
    fs.mkdirSync(path.dirname(codexFile()), { recursive: true }); fs.writeFileSync(codexFile(), `${block('/x')}\n`);
    const steps = env.steps({ sync: true }, ['codex']);
    assert.match(env.texts(steps).join('\n'), /codex: plugin-root-rule exists \(not created by adapter\)/);
    env.sync(['codex']); assert.equal(read(codexFile()), `${block('/x')}\n`);
  });
  it('a missing rule source is reported and the block is still written', () => {
    const e2 = makeEnv({ ruleSrc: false });
    const ad = e2.adapter(); ad.execute(ad.plan({ sync: true }, ['codex']));
    assert.match(e2.logs.join('\n'), /source missing/); assert.ok(!fs.existsSync(e2.cfg.ruleLink)); assert.ok(!e2.state().rules?.includes('link'));
    e2.cleanup();
  });
});

describe('rule: broken markers', () => {
  const put = (text) => { fs.mkdirSync(path.dirname(codexFile()), { recursive: true }); fs.writeFileSync(codexFile(), text); };
  for (const [name, text] of [['only the start marker', `a\n${START}\nb\n`], ['only the end marker', `a\n${END}\n`], ['the end before the start', `${END}\n${START}\n`]]) {
    it(`${name}: a note, no write, no crash`, () => {
      put(text);
      const steps = env.sync(['codex']);
      assert.match(env.texts(steps).join('\n'), /codex: .*broken marketplace marker/);
      assert.equal(read(codexFile()), text); assert.deepEqual(bak(codexFile()), []);
    });
  }
  it('two blocks (two pairs of markers): a note, no write', () => {
    put(`${block('/a')}\nmiddle text of the user\n${block('/b')}\n`);
    const steps = env.sync(['codex']);
    assert.match(env.texts(steps).join('\n'), /broken marketplace marker/);
    assert.ok(read(codexFile()).includes('middle text of the user'));
  });
  it('uninstall also refuses and keeps the file', () => {
    env.sync(['codex']); const ok = read(codexFile());
    put(`${START}\n${ok}`);
    const steps = env.apply(req({ uninstall: ['root-rule'] }), ['codex']);
    assert.deepEqual(env.changes(steps).filter((x) => x.includes('codex')), []);
    assert.equal(read(codexFile()), `${START}\n${ok}`);
  });
  it('the other tools are still handled', () => {
    put(`${START}\n`);
    env.sync(); assert.ok(fs.existsSync(env.cfg.vscodeRuleFile)); assert.ok(read(env.cfg.opencodeAgents).includes(START));
  });
});

describe('rule: refresh', () => {
  it('replaces only the block when the link path changed, and keeps the text around it', () => {
    fs.mkdirSync(path.dirname(codexFile()), { recursive: true }); fs.writeFileSync(codexFile(), 'before\n');
    env.sync(['codex']);
    fs.writeFileSync(codexFile(), `top\n${read(codexFile())}bottom\n`);
    const ad = env.adapter({ ruleLink: '/new/place.md' });
    assert.deepEqual(env.changes(ad.plan({ sync: true }, ['codex'])), []); // a plain run does not rewrite an existing block
    const steps = ad.plan(req({ update: ['root-rule'] }), ['codex']);
    assert.ok(env.changes(steps).some((x) => x.includes('codex: plugin-root-rule (update)')));
    ad.execute(steps);
    assert.ok(read(codexFile()).startsWith('top\nbefore\n')); assert.ok(read(codexFile()).endsWith(`${block('/new/place.md')}\nbottom\n`));
    assert.equal(read(codexFile()).split(START).length, 2);
  });
  it('refreshes the VS Code file when the content differs', () => {
    env.sync(['vscode']); fs.writeFileSync(env.cfg.vscodeRuleFile, 'old');
    assert.deepEqual(env.sync(['vscode']), []); assert.equal(read(env.cfg.vscodeRuleFile), 'old'); // a plain run leaves it
    const steps = env.apply(req({ update: ['root-rule'] }), ['vscode']);
    assert.deepEqual(env.changes(steps), ['~ vscode: plugin-root-rule (update)']);
    assert.ok(read(env.cfg.vscodeRuleFile).includes(START)); assert.equal(bak(env.cfg.vscodeRuleFile).length, 1);
  });
  it('does not refresh a block that the adapter did not create', () => {
    fs.mkdirSync(path.dirname(codexFile()), { recursive: true }); fs.writeFileSync(codexFile(), `${block('/x')}\n`);
    assert.deepEqual(env.changes(env.steps({ sync: true }, ['codex'])).filter((x) => x.includes('plugin-root-rule')), []);
  });
  it('repairs the rule link when the marketplace moved', () => {
    env.sync(['codex']);
    fs.mkdirSync(env.p('moved')); const e = env.adapter({ ruleSrc: env.p('moved', 'rule.md') }); fs.writeFileSync(env.p('moved', 'rule.md'), '# new\n');
    const steps = e.plan({ sync: true }, ['codex']);
    assert.deepEqual(env.changes(steps), ['~ rules: link (update)']); e.execute(steps);
    assert.equal(fs.readlinkSync(env.cfg.ruleLink), env.p('moved', 'rule.md'));
  });
  it('repairs a dangling rule link', () => {
    env.sync(['codex']); fs.rmSync(env.cfg.ruleSrc);
    fs.writeFileSync(env.cfg.ruleSrc, '# again\n'); fs.unlinkSync(env.cfg.ruleLink); fs.symlinkSync('/gone/rule.md', env.cfg.ruleLink);
    assert.ok(!fs.existsSync(env.cfg.ruleLink));
    env.sync(['codex']); assert.ok(fs.existsSync(env.cfg.ruleLink));
  });
});

describe('rule: uninstall', () => {
  beforeEach(() => env.sync());
  it('removes the block and keeps the text of the user', () => {
    fs.writeFileSync(codexFile(), `top\n\n${read(codexFile())}\nbottom\n`);
    env.apply(req({ uninstall: ['root-rule'] }), ['codex']);
    assert.equal(read(codexFile()), 'top\n\nbottom\n');
  });
  it('removes a block at the end of the text and the blank line before it', () => {
    fs.writeFileSync(codexFile(), `top\n\n${block(env.cfg.ruleLink)}\n`);
    env.apply(req({ uninstall: ['root-rule'] }), ['codex']);
    assert.equal(read(codexFile()), 'top\n');
  });
  it('removes a block at the start of the text', () => {
    fs.writeFileSync(codexFile(), `${block(env.cfg.ruleLink)}\n\nbottom\n`);
    env.apply(req({ uninstall: ['root-rule'] }), ['codex']);
    assert.equal(read(codexFile()), 'bottom\n');
  });
  it('deletes the file when the block was all there was', () => {
    env.apply(req({ uninstall: ['root-rule'] }), ['codex']); assert.ok(!fs.existsSync(codexFile()));
  });
  it('makes a backup first', () => {
    fs.writeFileSync(codexFile(), `top\n\n${read(codexFile())}`);
    env.apply(req({ uninstall: ['root-rule'] }), ['codex']); assert.ok(bak(codexFile()).length >= 1);
  });
  it('removes the VS Code file', () => { env.apply(req({ uninstall: ['root-rule'] }), ['vscode']); assert.ok(!fs.existsSync(env.cfg.vscodeRuleFile)); });
  it('keeps a VS Code file that the user changed, and says so', () => {
    fs.writeFileSync(env.cfg.vscodeRuleFile, 'my own words');
    env.clearLogs(); env.apply(req({ uninstall: ['root-rule'] }), ['vscode']);
    assert.equal(read(env.cfg.vscodeRuleFile), 'my own words'); assert.match(env.logs.join('\n'), /changed by the user/);
    assert.ok(env.state().vscode.includes('plugin-root-rule'));
  });
  it('does not touch a block the user wrote', () => {
    fs.rmSync(env.cfg.stateFile);
    const steps = env.apply(req({ uninstall: ['root-rule'] }), ['codex']);
    assert.deepEqual(env.changes(steps).filter((x) => x.includes('codex')), []); assert.ok(read(codexFile()).includes(START));
  });
  it('keeps the rule link while one tool still has the rule', () => {
    env.apply(req({ uninstall: ['root-rule'] }), ['codex', 'opencode']);
    assert.ok(env.isLink(env.cfg.ruleLink));
  });
  it('keeps the rule link when only some tools are chosen but others are found and wanted', () => {
    env.apply(req({ uninstall: ['root-rule'] }), ['codex']); assert.ok(env.isLink(env.cfg.ruleLink));
  });
  it('removes the rule link when no tool wants the rule', () => {
    const steps = env.apply(req({ uninstall: ['root-rule'] }));
    assert.ok(env.changes(steps).includes('- rules: link (uninstall)')); assert.ok(!env.isLink(env.cfg.ruleLink));
    assert.ok(!env.state().rules.includes('link'));
  });
  it('does not delete a rule link that the user created', () => {
    const s = env.state(); s.rules = []; fs.writeFileSync(env.cfg.stateFile, JSON.stringify(s));
    env.apply(req({ uninstall: ['root-rule'] })); assert.ok(env.isLink(env.cfg.ruleLink));
  });
  it('a plain run does not write the rule again', () => {
    env.apply(req({ uninstall: ['root-rule'] })); assert.deepEqual(env.changes(env.steps({ sync: true })), []);
    assert.ok(!fs.existsSync(codexFile()));
  });
  it('install brings the rule back, with the link', () => {
    env.apply(req({ uninstall: ['root-rule'] })); env.apply(req({ install: ['root-rule'] }));
    assert.ok(read(codexFile()).includes(START) && env.isLink(env.cfg.ruleLink) && fs.existsSync(env.cfg.vscodeRuleFile));
  });
  it('the rule is independent of the plugins', () => {
    env.apply(req({ uninstall: ['root-rule'] })); assert.ok(env.codexNames.has('alpha-srv') && env.isLink(env.link('alpha-skill')));
    env.apply(req({ uninstall: ['alpha'] })); env.apply(req({ install: ['root-rule'] })); assert.ok(!env.codexNames.has('alpha-srv'));
  });
  it('update refreshes only a block that is out of date', () => {
    assert.deepEqual(env.changes(env.steps(req({ update: ['root-rule'] }))), []);
  });
});
