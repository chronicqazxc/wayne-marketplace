// Temporary local web page for the adapter. The page and the API run on 127.0.0.1 only, on a random port,
// and every request needs a random token. The server stops when the user closes the page (Quit button),
// when the page stops polling, or after an idle time. It uses the same core functions as the command line.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAdapter, AdapterError, TOOLS, LABEL } from './core.mjs';

const HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui.html');
const RULE = 'root-rule';
const IDLE_MS = 10 * 60 * 1000; // no request for this time: stop
const BYE_MS = 5000; // the page said bye (tab closed) and did not come back for this time: stop

// makeAdapter(log) must return a new adapter each call, so every status read is fresh.
export function startUi({ makeAdapter, out = console.log, open = true, idleMs = IDLE_MS, byeMs = BYE_MS }) {
  const token = crypto.randomBytes(16).toString('hex');
  let busy = false; let timer; let byeTimer; let server; let closing = false;
  return new Promise((resolve, reject) => {
    // Graceful stop: stop new connections, wait for a running change to end (never cut an apply in the middle), then close.
    const finish = async (code = 0) => {
      if (closing) return; closing = true;
      clearTimeout(timer); clearTimeout(byeTimer);
      process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
      server.close();
      while (busy) await new Promise((r) => setTimeout(r, 50));
      server.closeIdleConnections?.(); server.closeAllConnections?.();
      out('Adapter page stopped.'); resolve(code);
    };
    const onSignal = () => { out('Stopping…'); finish(0); };
    const touch = () => { clearTimeout(timer); timer = setTimeout(() => { out('UI idle. Stopped.'); finish(0); }, idleMs); };
    const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    const readBody = (req) => new Promise((ok, no) => { let s = ''; req.on('data', (c) => { s += c; if (s.length > 1e5) { no(new Error('body too large')); req.destroy(); } }); req.on('end', () => ok(s)); req.on('error', no); });
    const cleanTools = (list) => { const t = (Array.isArray(list) ? list : []).filter((x) => TOOLS.includes(x)); return t.length ? [...new Set(t)] : [...TOOLS]; };
    const names = (v) => (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string' && /^[\w.-]+$/.test(x));

    function state(toolsIn) {
      const logs = []; const ad = makeAdapter((l) => logs.push(l)); ad.discover();
      const found = ad.found(); const { usable, messages } = ad.usableTools(cleanTools(toolsIn).filter((t) => found[t]));
      return { found, labels: LABEL, tools: usable, messages, rows: usable.length ? ad.status(usable) : [] };
    }
    function run(body) {
      const logs = []; const ad = makeAdapter((l) => logs.push(l)); ad.discover();
      const found = ad.found(); const { usable } = ad.usableTools(cleanTools(body.tools).filter((t) => found[t]));
      if (!usable.length) throw new AdapterError('No supported tool found.');
      // The plugin root rule is required: never uninstall it, and install it with any other change.
      const rule = ad.status(usable).find((r) => r.name === RULE);
      const inst = names(body.install); const upd = names(body.update); const unin = names(body.uninstall).filter((x) => x !== RULE);
      if (rule && (inst.length || upd.length || unin.length)) {
        if (rule.can.install && !inst.includes(RULE)) inst.push(RULE);
        else if (!rule.can.install && upd.length && rule.can.update && !upd.includes(RULE)) upd.push(RULE);
      }
      const req = ad.resolveRequest({ install: inst, update: upd.filter((x) => !inst.includes(x)), uninstall: unin });
      const steps = ad.plan(req, usable);
      const changed = ad.changeCount(steps); const plan = ad.lines(steps);
      if (!body.dryRun && changed) ad.execute(steps);
      return { changed, plan, logs, applied: !body.dryRun && changed > 0 };
    }

    server = http.createServer(async (req, res) => {
      try {
        const host = (req.headers.host || '').replace(/:\d+$/, '');
        if (host !== '127.0.0.1' && host !== 'localhost') return send(res, 403, { error: 'bad host' });
        if (req.url === '/favicon.ico') { res.writeHead(204); return res.end(); }
        const u = new URL(req.url, 'http://127.0.0.1');
        if (u.searchParams.get('token') !== token) return send(res, 403, { error: 'bad token' });
        touch(); clearTimeout(byeTimer);
        if (req.method === 'GET' && u.pathname === '/') return send(res, 200, fs.readFileSync(HTML, 'utf8'), 'text/html');
        if (req.method === 'GET' && u.pathname === '/api/state') return send(res, 200, state((u.searchParams.get('tools') || '').split(',')));
        if (req.method === 'POST' && u.pathname === '/api/run') {
          if (busy) return send(res, 409, { error: 'Another change is running.' });
          busy = true;
          try { return send(res, 200, run(JSON.parse((await readBody(req)) || '{}'))); } finally { busy = false; }
        }
        if (req.method === 'POST' && u.pathname === '/api/bye') { byeTimer = setTimeout(() => { out('Page closed. Stopping.'); finish(0); }, byeMs); return send(res, 200, { ok: true }); }
        if (req.method === 'POST' && u.pathname === '/api/quit') { send(res, 200, { ok: true }); setTimeout(() => finish(0), 100); return; }
        send(res, 404, { error: 'not found' });
      } catch (e) { send(res, e instanceof AdapterError ? 400 : 500, { error: e.message }); }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/?token=${token}`;
      out(`Adapter page: ${url}`); out('Press Ctrl-C or use the Quit button to stop.');
      touch();
      if (open) { const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'; spawn(cmd, process.platform === 'win32' ? ['/c', 'start', '', url] : [url], { stdio: 'ignore', detached: true }).on('error', () => out('Could not open the browser. Open the URL by hand.')).unref(); }
      server.url = url;
    });
    process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  });
}
