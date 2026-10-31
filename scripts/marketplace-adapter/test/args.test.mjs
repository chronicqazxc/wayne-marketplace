import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../args.mjs';

const ALL = ['codex', 'opencode', 'vscode'];
const fails = (argv, re, opts) => assert.throws(() => parseArgs(argv, opts), re);

describe('parseArgs: modes', () => {
  it('no option, no terminal = sync', () => assert.equal(parseArgs([]).mode, 'sync'));
  it('no option, terminal = interactive', () => assert.equal(parseArgs([], { isTTY: true }).mode, 'interactive'));
  it('--yes in a terminal = sync', () => assert.equal(parseArgs(['--yes'], { isTTY: true }).mode, 'sync'));
  it('--no-interactive in a terminal = sync', () => assert.equal(parseArgs(['--no-interactive'], { isTTY: true }).mode, 'sync'));
  it('--dry-run in a terminal = sync (no questions)', () => assert.equal(parseArgs(['--dry-run'], { isTTY: true }).mode, 'sync'));
  it('--check in a terminal = sync', () => assert.equal(parseArgs(['--check'], { isTTY: true }).mode, 'sync'));
  it('--interactive without a terminal = interactive', () => assert.equal(parseArgs(['--interactive']).mode, 'interactive'));
  it('--status = status', () => assert.equal(parseArgs(['--status']).mode, 'status'));
  it('--status --json = status with json flag', () => assert.equal(parseArgs(['--status', '--json']).flags.json, true));
  it('--list = list, also in a terminal', () => assert.equal(parseArgs(['--list'], { isTTY: true }).mode, 'list'));
  it('--help = help', () => assert.equal(parseArgs(['--help']).mode, 'help'));
  it('an action option = explicit, also in a terminal', () => assert.equal(parseArgs(['--install', 'a'], { isTTY: true }).mode, 'explicit'));
  it('--dry-run with an action = explicit', () => assert.equal(parseArgs(['--dry-run', '--uninstall', 'a']).mode, 'explicit'));
});

describe('parseArgs: values', () => {
  it('splits a list and trims spaces', () => assert.deepEqual(parseArgs(['--install', 'a, b ,c']).request.install, ['a', 'b', 'c']));
  it('accepts --option=value', () => assert.deepEqual(parseArgs(['--uninstall=a,b']).request.uninstall, ['a', 'b']));
  it('merges an option that is given twice', () => assert.deepEqual(parseArgs(['--install', 'a', '--install', 'b']).request.install, ['a', 'b']));
  it('default tools = all', () => assert.deepEqual(parseArgs([]).tools, ALL));
  it('--ide all = all tools', () => assert.deepEqual(parseArgs(['--ide', 'all']).tools, ALL));
  it('--ide with a list', () => assert.deepEqual(parseArgs(['--ide', 'vscode,codex']).tools, ['vscode', 'codex']));
  it('--ide ignores case and duplicates', () => assert.deepEqual(parseArgs(['--ide=Codex,codex']).tools, ['codex']));
  it('--ide tells that the user gave it', () => assert.equal(parseArgs(['--ide', 'codex']).ideGiven, true));
  it('ideGiven is false by default', () => assert.equal(parseArgs([]).ideGiven, false));
  it('keeps the legacy --plugin-root-rule as a flag', () => assert.equal(parseArgs(['--plugin-root-rule']).flags['plugin-root-rule'], true));
});

describe('parseArgs: errors', () => {
  it('unknown option (typo) is an error', () => fails(['--unistall', 'a'], /Unknown option: --unistall/));
  it('unknown option with a value is an error', () => fails(['--foo=1'], /Unknown option: --foo/));
  it('a single dash option is an error', () => fails(['-y'], /Unexpected argument/));
  it('a positional argument is an error', () => fails(['--install', 'a', 'b'], /Unexpected argument: b/));
  it('--install without a value is an error', () => fails(['--install'], /--install needs a value/));
  it('--install followed by an option is an error', () => fails(['--install', '--dry-run'], /--install needs a value/));
  it('--install with an empty value is an error', () => fails(['--install='], /needs a value/));
  it('--install with only commas is an error', () => fails(['--install', ',,'], /needs a value/));
  it('a flag with a value is an error', () => fails(['--dry-run=yes'], /does not take a value/));
  it('unknown tool is an error', () => fails(['--ide', 'vim'], /Unknown tool: vim/));
  it('one unknown tool in a list is an error', () => fails(['--ide', 'codex,vim'], /Unknown tool: vim/));
  it('--json without --status is an error', () => fails(['--json'], /only with --status/));
  it('--status with an action is an error', () => fails(['--status', '--install', 'a'], /cannot be used/));
  it('--interactive with an action is an error', () => fails(['--interactive', '--install', 'a'], /cannot be used/));
  it('--interactive with --yes is an error', () => fails(['--interactive', '--yes'], /cannot be used/));
  it('--interactive with --no-interactive is an error', () => fails(['--interactive', '--no-interactive'], /cannot be used together/));
  it('--yes with an action is an error', () => fails(['--yes', '--uninstall', 'a'], /cannot be used/));
});

describe('parseArgs: interactive with a dry run', () => {
  it('--interactive with --dry-run is an error', () => fails(['--interactive', '--dry-run'], /cannot be used with --dry-run or --check/));
  it('--interactive with --check is an error', () => fails(['--interactive', '--check'], /cannot be used with --dry-run or --check/));
  it('keeps name@tool entries as they are', () => assert.deepEqual(parseArgs(['--install', 'a@codex+vscode,b']).request.install, ['a@codex+vscode', 'b']));
});

describe('--ui', () => {
  it('selects ui mode and rejects action options', () => {
    assert.equal(parseArgs(['--ui']).mode, 'ui');
    assert.throws(() => parseArgs(['--ui', '--install', 'a']));
    assert.throws(() => parseArgs(['--no-open']));
  });
});
