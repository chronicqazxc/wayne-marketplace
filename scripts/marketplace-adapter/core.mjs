// Core of the coding agent tool adapter. No side effects at import. All tool commands go through cfg.run, so tests can fake them.
//
// Model (kept small on purpose):
//   component  = a plugin, or the plugin root rule ("root-rule")
//   item       = one thing the adapter writes: an MCP server in one tool, a rule block in one tool, or a shared symlink
//   plan()     = pure: reads the machine and the state file, returns a list of steps. Nothing is written.
//   execute()  = the only function that writes. It runs the steps and saves the state file.
// Rule for every write: the adapter changes or removes only items that it created itself (listed in the state file).
import fs from 'node:fs';
import path from 'node:path';
import { parseJsonc, jsoncRemoveServer } from './jsonc.mjs';

export const TOOLS = ['codex', 'opencode', 'vscode'];
export const LABEL = { codex: 'Codex', opencode: 'OpenCode', vscode: 'VS Code' };
export const RULE = 'root-rule'; // component name of the plugin root rule
const RULE_ID = 'plugin-root-rule'; // id of the rule item in the state file
const RULE_START = '<!-- >>> marketplace:plugin-root >>> -->';
const RULE_END = '<!-- <<< marketplace:plugin-root <<< -->';

export class AdapterError extends Error {}

const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const exists = (p) => fs.existsSync(p) || isLink(p); // a dangling symlink also counts as present

export function createAdapter(cfg) {
  const log = cfg.log || (() => {});
  const now = cfg.now || Date.now;
  const backup = (file) => { if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak.${now()}`); };
  // Write a temp file, then rename it over the target. A crash never leaves a half file. A symlink is written through, never replaced.
  const writeFile = (file, body) => {
    const real = fs.existsSync(file) ? fs.realpathSync(file) : file;
    fs.mkdirSync(path.dirname(real), { recursive: true });
    const tmp = `${real}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, body);
    if (fs.existsSync(real)) fs.chmodSync(tmp, fs.statSync(real).mode);
    fs.renameSync(tmp, real);
  };

  // ---------- state file: what the adapter created, and which plugins the user uninstalled ----------
  //   { codex: [ids], opencode: [ids], vscode: [ids], skills: [names], rules: ['link'], excluded: { codex: [components] } }
  const state = (() => {
    if (!fs.existsSync(cfg.stateFile)) return {};
    let s; try { s = JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8')); } catch { s = null; }
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new AdapterError(`State file is not valid JSON: ${cfg.stateFile}. Fix it or delete it.`);
    return s;
  })();
  const owned = (store) => (Array.isArray(state[store]) ? state[store] : []);
  const isOwned = (store, id) => owned(store).includes(id);
  const setOwned = (store, id, on) => { state[store] = [...owned(store).filter((x) => x !== id), ...(on ? [id] : [])]; };
  const excludedOf = (tool) => (Array.isArray(state.excluded?.[tool]) ? state.excluded[tool] : []);
  const setExcluded = (tool, comp, on) => {
    state.excluded = { ...(state.excluded && typeof state.excluded === 'object' ? state.excluded : {}), [tool]: [...excludedOf(tool).filter((x) => x !== comp), ...(on ? [comp] : [])] };
  };
  const saveState = () => writeFile(cfg.stateFile, JSON.stringify(state, null, 2));

  // ---------- discover plugins (read only) ----------
  let discovered = null;
  function discover() {
    if (discovered) return discovered;
    const warnings = []; const plugins = []; const seen = new Set(); const seenServers = new Set();
    for (const name of fs.readdirSync(cfg.pluginsDir).sort()) {
      const dir = path.join(cfg.pluginsDir, name);
      let isDir = false; try { isDir = fs.statSync(dir).isDirectory(); } catch { /* a dangling symlink */ }
      if (!isDir) continue;
      if (fs.existsSync(path.join(dir, '.do-not-migrate'))) continue; // Claude Code only plugin
      const manifest = path.join(dir, '.claude-plugin', 'plugin.json');
      if (!fs.existsSync(manifest)) continue;
      let mcp;
      try { mcp = JSON.parse(fs.readFileSync(manifest, 'utf8')).mcpServers || {}; } catch { warnings.push(`! skip plugin ${name}: plugin.json is not valid JSON`); continue; }
      const sub = (v) => String(v).replaceAll('${CLAUDE_PLUGIN_ROOT}', dir);
      const servers = []; const skills = [];
      for (const [sname, def] of Object.entries(mcp)) {
        if (!def || (!def.url && !def.command)) { warnings.push(`! skip MCP server ${name}/${sname}: needs "command" or "url"`); continue; }
        if (seenServers.has(sname)) { warnings.push(`! skip duplicate MCP server name ${sname} (${name})`); continue; }
        seenServers.add(sname);
        const s = { name: sname, env: Object.fromEntries(Object.entries({ ...(def.env || {}), CLAUDE_PLUGIN_ROOT: dir }).map(([k, v]) => [k, sub(v)])) };
        if (def.url) s.url = sub(def.url); else s.cmd = [def.command, ...(def.args || [])].map(sub);
        servers.push(s);
      }
      const sd = path.join(dir, 'skills');
      for (const d of fs.existsSync(sd) ? fs.readdirSync(sd).sort() : []) {
        const f = path.join(sd, d, 'SKILL.md');
        if (!fs.existsSync(f)) continue;
        const fm = /^name:\s*(\S+)/m.exec(fs.readFileSync(f, 'utf8').split(/^---$/m)[1] || '');
        if (!fm || fm[1] !== d || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(d)) { warnings.push(`! skip skill ${name}/${d}: name must equal directory and be kebab-case`); continue; }
        if (seen.has(d)) { warnings.push(`! skip duplicate skill name ${d} (${name})`); continue; }
        seen.add(d); skills.push({ name: d, src: path.join(sd, d) });
      }
      if (servers.length || skills.length) plugins.push({ name, servers, skills });
    }
    return (discovered = { plugins, warnings });
  }

  // ---------- one driver for each tool: has / add / remove (all write at once) ----------
  const bin = (tool) => cfg.bins[tool];
  const envArgs = (s) => Object.entries(s.env).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
  const parseJsonOut = (r, what) => {
    let v = null; try { v = JSON.parse(r.stdout || ''); } catch { /* handled below */ }
    if (r.status !== 0 || v === null) throw new AdapterError(`${what} failed. Check that the tool works.`);
    return v;
  };

  // true when the tool shows a command or URL that is not the one the plugin has now (for example another source folder)
  const sameServer = (shown, s) => !shown || (!shown.cmd && !shown.url) ? false : s.url ? shown.url !== s.url : !!shown.cmd && JSON.stringify(shown.cmd) !== JSON.stringify(s.cmd);

  function makeCodex() {
    let names = null; // name -> { cmd, url } as the tool shows it. cmd and url are unknown when the tool does not show them.
    const load = () => names || (names = new Map(parseJsonOut(cfg.run(bin('codex'), ['mcp', 'list', '--json']), '"codex mcp list --json"')
      .map((x) => [x.name, { cmd: x.transport?.command ? [x.transport.command, ...(x.transport.args || [])] : null, url: x.transport?.url || null }])));
    return {
      check: load, has: (n) => load().has(n), refresh: () => { names = null; },
      moved: (s) => sameServer(load().get(s.name), s),
      add(s) {
        const a = ['mcp', 'add', s.name, ...envArgs(s)];
        const out = cfg.run(bin('codex'), s.url ? [...a, '--url', s.url] : [...a, '--', ...s.cmd]);
        if (out.status) { log(`! codex add ${s.name} failed: ${String(out.stderr).trim()}`); return false; }
        load().set(s.name, { cmd: s.url ? null : s.cmd, url: s.url || null }); return true;
      },
      remove(n) {
        const out = cfg.run(bin('codex'), ['mcp', 'remove', n]);
        if (out.status) { log(`! codex remove ${n} failed: ${String(out.stderr).trim()}`); return false; }
        load().delete(n); return true;
      },
      update(s) { return this.remove(s.name) && this.add(s); },
    };
  }

  function makeOpencode() {
    let names = null;
    const load = () => {
      if (names) return names;
      const docs = parseJsonOut(cfg.run(bin('opencode'), ['debug', 'config'], { cwd: cfg.home }), '"opencode debug config"');
      if (!Array.isArray(docs)) throw new AdapterError('"opencode debug config" gave an unknown format.');
      names = new Map();
      const shown = (e) => ({ cmd: Array.isArray(e?.command) ? e.command : null, url: e?.url || null });
      for (const doc of docs) {
        const m = doc?.info?.mcp || {};
        for (const k of Object.keys(m)) if (k !== 'servers') names.set(k, shown(m[k]));
        if (m.servers && typeof m.servers === 'object') for (const k of Object.keys(m.servers)) names.set(k, shown(m.servers[k]));
      }
      return names;
    };
    return {
      check: load, has: (n) => load().has(n), refresh: () => { names = null; },
      moved: (s) => sameServer(load().get(s.name), s),
      add(s) {
        const a = ['mcp', 'add', '--global', s.name, ...envArgs(s)];
        const out = cfg.run(bin('opencode'), s.url ? [...a, '--url', s.url] : [...a, '--', ...s.cmd], { cwd: cfg.home });
        if (out.status) { log(`! opencode add ${s.name} failed: ${String(out.stderr || out.stdout).trim()}`); return false; }
        load().set(s.name, { cmd: s.url ? null : s.cmd, url: s.url || null }); return true;
      },
      // OpenCode v2 has no "mcp remove" command, so the adapter edits the config text. It refuses if it cannot verify the result.
      remove(n) {
        if (!fs.existsSync(cfg.opencodeConfig)) { log(`! opencode: config not found: ${cfg.opencodeConfig}`); return false; }
        let text = fs.readFileSync(cfg.opencodeConfig, 'utf8'); let removed = 0;
        for (let next = jsoncRemoveServer(text, n); next !== null && removed < 5; next = jsoncRemoveServer(text, n)) { text = next; removed++; } // the name can be in mcp.X and mcp.servers.X
        if (!removed) { log(`! opencode: cannot remove ${n} from ${cfg.opencodeConfig} safely — remove it by hand`); return false; }
        backup(cfg.opencodeConfig); writeFile(cfg.opencodeConfig, text);
        load().delete(n); return true;
      },
      update(s) { return this.remove(s.name) && this.add(s); },
    };
  }

  function makeVscode() {
    let conf = null; let saved = false;
    const load = () => {
      if (conf) return conf;
      let o = { servers: {} };
      if (fs.existsSync(cfg.vscodeMcp)) { try { o = parseJsonc(fs.readFileSync(cfg.vscodeMcp, 'utf8')); } catch { o = null; } }
      const bad = !o || typeof o !== 'object' || Array.isArray(o) || (o.servers !== undefined && (!o.servers || typeof o.servers !== 'object' || Array.isArray(o.servers)));
      if (bad) throw new AdapterError(`VS Code: ${cfg.vscodeMcp} is not valid JSON. Fix it first.`);
      o.servers ||= {};
      return (conf = o);
    };
    // Read the file again before each change and change only one key, so an edit made meanwhile is not lost.
    // Comments in the file are lost on a rewrite, so keep one backup for each run.
    const change = (fn) => {
      conf = null; fn(load());
      if (!saved) { backup(cfg.vscodeMcp); saved = true; }
      writeFile(cfg.vscodeMcp, JSON.stringify(conf, null, 2) + '\n');
    };
    // VS Code runs from the Dock with a short PATH. The command sets CLAUDE_PLUGIN_ROOT, PATH and the folder itself.
    const PATH = [...new Set([path.dirname(cfg.nodePath), ...(cfg.envPath || '').split(':'), path.join(cfg.home, '.local', 'bin'),
      path.join(cfg.home, '.local', 'share', 'mise', 'shims'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean))].join(':');
    const q = (v) => `'${String(v).replaceAll("'", `'\\''`)}'`;
    const entry = (s) => (s.url ? { type: 'http', url: s.url } : {
      type: 'stdio', command: '/bin/bash',
      args: ['-c', `export CLAUDE_PLUGIN_ROOT=${q(s.env.CLAUDE_PLUGIN_ROOT)} PATH=${q(PATH)}; cd "$CLAUDE_PLUGIN_ROOT" && exec "$@"`, 'marketplace-adapter', ...s.cmd],
      cwd: s.env.CLAUDE_PLUGIN_ROOT, env: { ...s.env, PATH },
    });
    return {
      check: load, has: (n) => n in load().servers, refresh: () => { conf = null; },
      add(s) { change((c) => { c.servers[s.name] = entry(s); }); return true; },
      remove(n) { change((c) => { delete c.servers[n]; }); return true; },
      update(s) { return this.add(s); },
      stale: (s) => JSON.stringify(load().servers[s.name]) !== JSON.stringify(entry(s)),
      moved: (s) => sameServer({ cmd: load().servers[s.name]?.args || null, url: load().servers[s.name]?.url || null }, { url: s.url, cmd: entry(s).args }),
    };
  }
  const drivers = {};
  const driver = (tool) => (drivers[tool] ||= { codex: makeCodex, opencode: makeOpencode, vscode: makeVscode }[tool]());

  const found = () => ({ codex: !!bin('codex'), opencode: !!bin('opencode'), vscode: fs.existsSync(path.dirname(cfg.vscodeMcp)) });
  function usableTools(tools) {
    const f = found(); const usable = []; const messages = [];
    for (const t of tools) {
      if (!f[t]) { messages.push(`~ ${LABEL[t]} not installed — skipped`); continue; }
      try { driver(t).check(); usable.push(t); } catch (e) { if (!(e instanceof AdapterError)) throw e; messages.push(`! ${LABEL[t]}: ${e.message} — skipped`); }
    }
    return { usable, messages };
  }

  // ---------- items ----------
  // item = { store, id, present(), add(), remove(), update(), stale(), canCompare, problem?() }
  const symlinkItem = (store, id, src, dst) => {
    const ours = () => isLink(dst) && path.basename(fs.readlinkSync(dst)) === path.basename(src); // not a link that the user pointed to something else
    return {
    store, id, canCompare: true,
    present: () => exists(dst),
    add() {
      if (!fs.existsSync(src)) { log(`! ${id}: source missing: ${src}`); return false; }
      fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.symlinkSync(src, dst); return true;
    },
    remove() { if (!ours()) return false; fs.unlinkSync(dst); return true; }, // never delete a real file or folder
    update() { if (!ours()) return false; fs.unlinkSync(dst); fs.symlinkSync(src, dst); return true; },
    stale: () => ours() && fs.readlinkSync(dst) !== src,
    };
  };
  const serverItem = (tool, s) => {
    const d = driver(tool);
    return { store: tool, id: s.name, canCompare: !!d.stale, present: () => d.has(s.name), add: () => d.add(s), remove: () => d.remove(s.name), update: () => d.update(s), stale: () => (d.stale ? d.stale(s) : false), moved: () => (d.moved ? d.moved(s) : false) };
  };

  const ruleBlock = () => `${RULE_START}\nIf a skill uses \`\${CLAUDE_PLUGIN_ROOT}\`, read ${cfg.ruleLink} first.\n${RULE_END}`;
  const vscodeRuleText = () => `---\nname: plugin-root\ndescription: How to find \${CLAUDE_PLUGIN_ROOT} for marketplace skills\napplyTo: "**"\n---\n${ruleBlock()}\n`;
  function ruleItem(tool) {
    if (tool === 'vscode') { // the adapter owns this whole file
      const file = cfg.vscodeRuleFile;
      return {
        store: tool, id: RULE_ID, canCompare: true,
        present: () => fs.existsSync(file),
        add() { writeFile(file, vscodeRuleText()); return true; },
        update() { backup(file); writeFile(file, vscodeRuleText()); return true; },
        remove() {
          if (fs.readFileSync(file, 'utf8') !== vscodeRuleText()) { log(`! vscode: ${file} was changed by the user — left alone`); return false; }
          fs.unlinkSync(file); return true;
        },
        stale: () => fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== vscodeRuleText(),
      };
    }
    const file = tool === 'codex' ? cfg.codexAgents : cfg.opencodeAgents; // a block between markers in the user file
    const read = () => {
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      const s = text.indexOf(RULE_START); const e = text.indexOf(RULE_END);
      const n = (m) => text.split(m).length - 1; // exactly one pair of markers, in the right order, or we do not touch the file
      return { text, s, e: e + RULE_END.length, broken: n(RULE_START) !== n(RULE_END) || n(RULE_START) > 1 || (s >= 0 && e < s) };
    };
    const replace = (p, block) => { if (p.s < 0 || p.broken) return false; backup(file); writeFile(file, p.text.slice(0, p.s) + block + p.text.slice(p.e)); return true; };
    return {
      store: tool, id: RULE_ID, canCompare: true,
      problem: () => (read().broken ? `${file} has a broken marketplace marker — fix it by hand` : null),
      present: () => read().s >= 0,
      add() {
        const p = read(); const sep = !p.text ? '' : p.text.endsWith('\n\n') ? '' : p.text.endsWith('\n') ? '\n' : '\n\n';
        backup(file); writeFile(file, `${p.text}${sep}${ruleBlock()}\n`); return true;
      },
      update: () => replace(read(), ruleBlock()),
      remove() {
        const p = read(); if (p.s < 0 || p.broken) return false;
        backup(file);
        const rest = (p.text.slice(0, p.s).replace(/\n+$/, '\n') + p.text.slice(p.e).replace(/^\n/, '')).replace(/^\n+/, '');
        if (rest.trim() || isLink(file)) writeFile(file, rest); else fs.unlinkSync(file); // only our block was there: remove the file, but never a symlink
        return true;
      },
      stale() { const p = read(); return p.s >= 0 && p.text.slice(p.s, p.e) !== ruleBlock(); },
    };
  }

  // ---------- components ----------
  function components() {
    const comps = discover().plugins.map((p) => ({
      name: p.name, kind: 'plugin', skills: p.skills.length, mcp: p.servers.length,
      toolItems: (t) => p.servers.map((s) => serverItem(t, s)),
      sharedItems: () => p.skills.map((k) => symlinkItem('skills', k.name, k.src, path.join(cfg.skillsDir, k.name))),
    }));
    if (cfg.includeRule !== false) {
      comps.push({ name: RULE, kind: 'rule', skills: 0, mcp: 0, toolItems: (t) => [ruleItem(t)], sharedItems: () => [symlinkItem('rules', 'link', cfg.ruleSrc, cfg.ruleLink)] });
    }
    return comps;
  }
  const hasToolItems = (c) => c.kind === 'rule' || c.mcp > 0;

  // ---------- status ----------
  // state of a component in a tool: none | partial | installed. external = the user installed it (the adapter must not change it).
  function status(tools) {
    return components().map((c, i) => {
      const perTool = {};
      for (const t of tools) {
        const flags = [...c.toolItems(t), ...c.sharedItems()].filter((it) => !it.problem?.()).map((it) => ({ present: it.present(), own: isOwned(it.store, it.id) }));
        const n = flags.filter((f) => f.present).length;
        perTool[t] = {
          state: n === 0 ? 'none' : n === flags.length ? 'installed' : 'partial',
          external: n > 0 && flags.every((f) => !f.present || !f.own),
          ownedAny: flags.some((f) => f.present && f.own),
          excluded: excludedOf(t).includes(c.name),
        };
      }
      const some = (fn) => tools.some((t) => fn(perTool[t]));
      return { index: i + 1, name: c.name, kind: c.kind, skills: c.skills, mcp: c.mcp, state: perTool,
        can: { install: some((s) => s.state !== 'installed'), update: some((s) => s.ownedAny), uninstall: some((s) => s.ownedAny) } };
    });
  }

  // ---------- plan (reads only) ----------
  // req = { sync: true }                                   install every component that the user did not uninstall
  //     | { install: [names], update: [names], uninstall: [names] }
  function plan(req, tools, { force = false } = {}) {
    const comps = components(); const byName = new Map(comps.map((c) => [c.name, c]));
    const f = found(); const foundTools = TOOLS.filter((t) => f[t]);
    const ex = new Set(foundTools.flatMap((t) => excludedOf(t).map((c) => `${t}|${c}`))); // exclusions as they will be after the plan
    const steps = [];
    const note = (text) => steps.push({ kind: 'note', text });
    const act = (kind, where, item, what) => steps.push({ kind, where, item, text: `${{ add: '+', update: '~', remove: '-' }[kind]} ${where}: ${item.id} (${what})` });

    // action: sync | install | update | uninstall
    function decide(action, where, item) {
      const problem = item.problem?.(); if (problem) return note(`! ${where}: ${problem}`);
      const present = item.present(); const own = isOwned(item.store, item.id);
      if (action === 'uninstall') {
        if (!present) return undefined;
        return own ? act('remove', where, item, 'uninstall') : note(`= ${where}: ${item.id} installed by user — left alone`);
      }
      if (action === 'update') {
        if (!present) return note(`= ${where}: ${item.id} is not installed — use install`);
        if (!own) return note(`= ${where}: ${item.id} installed by user — left alone`);
        return !item.canCompare || item.stale() ? act('update', where, item, 'update') : undefined;
      }
      if (present) { // sync or install
        if (!own) return note(`= ${where}: ${item.id} exists (not created by adapter) — left alone`);
        if (item.moved?.()) return note(`! ${where}: ${item.id} points to another folder — run update to repoint it`);
        return undefined; // a plain run never rewrites an entry that exists. Use update for that.
      }
      if (action === 'sync' && own && !force) return note(`- ${where}: ${item.id} was removed by user — skipped (use --force)`);
      return act('add', where, item, 'install');
    }
    // Shared items (skill links, rule link) exist while at least one tool wants the component.
    function shared(c, action) {
      const wanted = foundTools.some((t) => !ex.has(`${t}|${c.name}`));
      for (const item of c.sharedItems()) {
        const present = item.present(); const own = isOwned(item.store, item.id);
        if (!wanted) { if (present) own ? act('remove', item.store, item, 'uninstall') : note(`= ${item.store}: ${item.id} installed by user — left alone`); continue; }
        if (!present) {
          if (action === 'update') continue;
          if (action === 'sync' && own && !force) note(`- ${item.store}: ${item.id} was removed by user — skipped (use --force)`);
          else act('add', item.store, item, 'install');
        } else if (!own) { if (action !== 'update') note(`= ${item.store}: ${item.id} exists (not created by adapter) — left alone`); }
        else if (action !== 'uninstall' && item.stale()) act('update', item.store, item, 'update');
      }
    }

    if (req.sync) {
      for (const t of tools) for (const c of comps) if (!ex.has(`${t}|${c.name}`)) for (const item of c.toolItems(t)) decide('sync', t, item);
      for (const c of comps) shared(c, 'sync');
      return steps;
    }
    for (const action of ['uninstall', 'update', 'install']) {
      for (const entry of req[action] || []) {
        const { name, tools: own } = typeof entry === 'string' ? { name: entry, tools: null } : entry; // own = tools given with name@tool
        const c = byName.get(name);
        const bad = (own || []).find((t) => !tools.includes(t));
        if (bad) throw new AdapterError(`${name}@${bad}: ${LABEL[bad]} is not available`);
        // A component without tool items (skills only) is shared by all tools, so the action covers all tools.
        for (const t of hasToolItems(c) ? own || tools : foundTools) {
          if (action === 'uninstall') { ex.add(`${t}|${name}`); steps.push({ kind: 'exclude', tool: t, comp: name }); }
          if (action === 'install') { ex.delete(`${t}|${name}`); steps.push({ kind: 'unexclude', tool: t, comp: name }); }
          for (const item of c.toolItems(t)) decide(action, t, item);
        }
        shared(c, action);
      }
    }
    return steps;
  }

  // Check and expand a user request. Throws AdapterError for a bad request.
  // An entry is "name" (all chosen tools) or "name@codex+vscode" (those tools only). "all" means every component that is not named in any list.
  // Returns { install: [{ name, tools }], ... } where tools is null (all chosen tools) or a list.
  function resolveRequest(raw) {
    const names = components().map((c) => c.name);
    const parse = (tok) => {
      const at = tok.indexOf('@');
      if (at < 0) return { name: tok, tools: null };
      const tools = [...new Set(tok.slice(at + 1).split('+').map((s) => s.trim().toLowerCase()).filter(Boolean))];
      if (!tools.length || tools.some((x) => !TOOLS.includes(x))) throw new AdapterError(`Bad tool list in "${tok}". Use name@${TOOLS.join('+')}`);
      return { name: tok.slice(0, at), tools };
    };
    const parsed = Object.fromEntries(Object.keys({ install: 1, update: 1, uninstall: 1 }).map((a) => [a, (raw[a] || []).map(parse)]));
    const named = new Set(Object.values(parsed).flat().map((e) => e.name).filter((n) => n !== 'all'));
    const out = {};
    for (const action of Object.keys(parsed)) {
      const byNameTools = new Map(); // one entry for each name: the same name twice is merged, so no step is planned twice
      for (const e of parsed[action]) {
        let list;
        if (e.name === 'all') {
          if (action === 'uninstall') throw new AdapterError('"all" is not allowed for uninstall. Name the plugins.');
          list = names.filter((x) => !named.has(x));
        } else if (!names.includes(e.name)) throw new AdapterError(`Unknown plugin: ${e.name}. Use --status to see the names.`);
        else list = [e.name];
        for (const n of list) {
          const old = byNameTools.get(n);
          byNameTools.set(n, old === undefined ? e.tools : old === null || e.tools === null ? null : [...new Set([...old, ...e.tools])]);
        }
      }
      out[action] = [...byNameTools].map(([name, tools]) => ({ name, tools }));
    }
    const covers = (e) => e.tools || TOOLS;
    for (const n of names) { // a component may be in two lists only for different tools
      const hits = Object.keys(out).flatMap((a) => out[a].filter((e) => e.name === n).map((e) => ({ a, e })));
      for (let x = 0; x < hits.length; x++) for (let y = x + 1; y < hits.length; y++) {
        if (covers(hits[x].e).some((tool) => covers(hits[y].e).includes(tool))) throw new AdapterError(`${n} is in more than one list (${hits[x].a}, ${hits[y].a}) for the same tool.`);
      }
    }
    return out;
  }

  const lines = (steps) => steps.filter((s) => s.kind === 'note' || s.text).map((s) => s.text);
  const changeCount = (steps) => steps.filter((s) => s.kind === 'add' || s.kind === 'update' || s.kind === 'remove').length;

  // ---------- execute (the only function that writes) ----------
  // The machine can change between plan and execute (a prompt waits, another program writes). So each step checks again before it writes.
  function execute(steps) {
    for (const d of Object.values(drivers)) d.refresh(); // read the tools again: the cached lists can be old
    for (const st of steps) {
      if (st.kind === 'note') { log(st.text); continue; }
      if (st.kind === 'exclude' || st.kind === 'unexclude') { setExcluded(st.tool, st.comp, st.kind === 'exclude'); saveState(); continue; }
      const { item } = st;
      try { // one failed step never stops the others
        const problem = item.problem?.(); const present = item.present();
        if (problem) { log(`! ${st.where}: ${problem}`); continue; }
        if (st.kind === 'add' && present) { log(`= ${st.where}: ${item.id} appeared meanwhile — left alone`); continue; }
        if (st.kind !== 'add' && !present) { // the item is gone already
          log(`= ${st.where}: ${item.id} is gone already`); setOwned(item.store, item.id, false); saveState(); continue;
        }
        log(st.text);
        if (st.kind === 'add') { if (item.add()) setOwned(item.store, item.id, true); else log(`! ${st.where}: ${item.id} was not installed`); }
        else if (st.kind === 'update') { if (!item.update() && !item.present()) setOwned(item.store, item.id, false); } // lost: the next sync installs it again
        else if (item.remove()) setOwned(item.store, item.id, false);
        else log(`! ${st.where}: ${item.id} was not removed`);
      } catch (e) { log(`! ${st.where}: ${item.id} failed: ${e.message}`); }
      saveState(); // after each step, so a crash or Ctrl-C never loses what was already done
    }
    saveState();
  }

  return { found, discover, status, plan, resolveRequest, lines, changeCount, execute, usableTools, state: () => JSON.parse(JSON.stringify(state)) };
}

// ---------- parse a typed selection: numbers, ranges, names, "all" ----------
// rows come from status(). Returns { names, warnings }.
export function parseSelection(input, action, rows) {
  const names = []; const warnings = [];
  const add = (r) => { if (!r.can[action]) warnings.push(`! ${r.name}: cannot ${action} (see the table)`); else if (!names.includes(r.name)) names.push(r.name); };
  for (const tok of String(input).trim().split(/[,\s]+/).filter(Boolean)) {
    if (tok.toLowerCase() === 'all') {
      if (action === 'uninstall') warnings.push('! "all" is not allowed for uninstall. Type the numbers or names.');
      else if (!names.includes('all')) names.push('all'); // resolveRequest expands it and skips plugins that are named in a list
      continue;
    }
    const range = /^(\d+)-(\d+)$/.exec(tok);
    let picked;
    if (range) { const [a, b] = [Number(range[1]), Number(range[2])].sort((x, y) => x - y); picked = rows.filter((r) => r.index >= a && r.index <= b); }
    else if (/^\d+$/.test(tok)) picked = rows.filter((r) => r.index === Number(tok));
    else picked = rows.filter((r) => r.name === tok);
    if (!picked.length) warnings.push(`! unknown plugin: ${tok}`);
    picked.forEach(add);
  }
  return { names, warnings };
}
