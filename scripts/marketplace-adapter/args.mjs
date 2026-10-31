// Command line parser. Strict on purpose: an unknown option is an error, never a silent plain run.
import { TOOLS } from './core.mjs';

const BOOL = ['dry-run', 'check', 'force', 'list', 'status', 'json', 'yes', 'interactive', 'no-interactive', 'no-plugin-root-rule', 'plugin-root-rule', 'help', 'ui', 'no-open'];
const VALUE = ['ide', 'install', 'update', 'uninstall'];

// Returns { mode, tools, ideGiven, request, flags }. Throws Error with a clear message for a bad command line.
// mode: help | list | ui | status | explicit | interactive | sync
export function parseArgs(argv, { isTTY = false } = {}) {
  const flags = {}; const values = { ide: [], install: [], update: [], uninstall: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`Unexpected argument: ${a}`);
    const eq = a.indexOf('=');
    const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
    let val = eq < 0 ? undefined : a.slice(eq + 1);
    if (BOOL.includes(name)) {
      if (val !== undefined) throw new Error(`--${name} does not take a value`);
      flags[name] = true;
    } else if (VALUE.includes(name)) {
      if (val === undefined) { val = argv[i + 1]; i++; }
      if (val === undefined || val.startsWith('--')) throw new Error(`--${name} needs a value`);
      const list = val.split(',').map((s) => s.trim()).filter(Boolean);
      if (!list.length) throw new Error(`--${name} needs a value`);
      values[name].push(...list);
    } else throw new Error(`Unknown option: --${name}`);
  }

  const ides = values.ide.map((s) => s.toLowerCase());
  const bad = ides.filter((t) => t !== 'all' && !TOOLS.includes(t));
  if (bad.length) throw new Error(`Unknown tool: ${bad.join(', ')}. Use all or: ${TOOLS.join(', ')}`);
  const tools = !ides.length || ides.includes('all') ? [...TOOLS] : [...new Set(ides)];
  const request = { install: values.install, update: values.update, uninstall: values.uninstall };
  const hasActions = Object.values(request).some((l) => l.length);

  if (flags['no-open'] && !flags.ui) throw new Error('--no-open works only with --ui');
  if (flags.ui && (hasActions || flags.status || flags.list || flags.yes || flags.interactive || flags['dry-run'] || flags.check || flags.json)) throw new Error('--ui cannot be used with other action options');
  if (flags.json && !flags.status) throw new Error('--json works only with --status');
  if (flags.status && hasActions) throw new Error('--status cannot be used with --install, --update or --uninstall');
  if (flags.interactive && (flags['dry-run'] || flags.check)) throw new Error('--interactive cannot be used with --dry-run or --check (the plan is shown before you confirm)');
  if (flags.interactive && flags['no-interactive']) throw new Error('--interactive and --no-interactive cannot be used together');
  if (flags.interactive && (hasActions || flags.yes)) throw new Error('--interactive cannot be used with --yes, --install, --update or --uninstall');
  if (flags.yes && hasActions) throw new Error('--yes cannot be used with --install, --update or --uninstall');

  let mode;
  if (flags.help) mode = 'help';
  else if (flags.list) mode = 'list';
  else if (flags.ui) mode = 'ui';
  else if (flags.status) mode = 'status';
  else if (hasActions) mode = 'explicit';
  else if (flags.interactive) mode = 'interactive';
  else if (isTTY && !flags.yes && !flags['no-interactive'] && !flags['dry-run'] && !flags.check) mode = 'interactive';
  else mode = 'sync';
  return { mode, tools, ideGiven: values.ide.length > 0, request, flags };
}
