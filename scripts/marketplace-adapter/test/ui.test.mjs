import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './harness.mjs';
import { startUi } from '../ui.mjs';
import { createAdapter } from '../core.mjs';

let env; let done; let base; let token;
beforeEach(async () => {
  env = makeEnv(); const lines = [];
  done = startUi({ makeAdapter: (log) => createAdapter({ ...env.cfg, log }), out: (l) => lines.push(l), open: false, idleMs: 60000 });
  while (!lines.length) await new Promise((r) => setTimeout(r, 10));
  const u = new URL(lines[0].replace('Adapter page: ', '')); base = u.origin; token = u.searchParams.get('token');
});
afterEach(async () => { await fetch(`${base}/api/quit?token=${token}`, { method: 'POST' }); await done; env.cleanup(); });
const post = (body) => fetch(`${base}/api/run?token=${token}`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());

describe('ui server', () => {
  it('refuses a request without the token', async () => {
    assert.equal((await fetch(`${base}/api/state`)).status, 403);
  });
  it('shows the state, installs a plugin and shows the new state', async () => {
    const s0 = await (await fetch(`${base}/api/state?token=${token}`)).json();
    assert.ok(s0.rows.length > 0);
    const alpha = s0.rows.find((r) => r.name === 'alpha');
    assert.equal(alpha.state.codex.state, 'none');
    const dry = await post({ tools: ['codex'], install: ['alpha'], dryRun: true });
    assert.ok(dry.changed > 0 && !dry.applied);
    assert.equal((await (await fetch(`${base}/api/state?tools=codex&token=${token}`)).json()).rows.find((r) => r.name === 'alpha').state.codex.state, 'none');
    assert.ok((await post({ tools: ['codex'], install: ['alpha'] })).applied);
    const s1 = await (await fetch(`${base}/api/state?tools=codex&token=${token}`)).json();
    assert.equal(s1.rows.find((r) => r.name === 'alpha').state.codex.state, 'installed');
  });
  it('returns an error for an unknown plugin', async () => {
    const r = await fetch(`${base}/api/run?token=${token}`, { method: 'POST', body: JSON.stringify({ install: ['nope'] }) });
    assert.equal(r.status, 400);
  });
});

describe('ui server stop', () => {
  it('stops by itself when the page says bye and does not come back', async () => {
    const lines = [];
    const p = startUi({ makeAdapter: (log) => createAdapter({ ...env.cfg, log }), out: (l) => lines.push(l), open: false, byeMs: 100 });
    while (!lines.length) await new Promise((r) => setTimeout(r, 10));
    const u = new URL(lines[0].replace('Adapter page: ', ''));
    await fetch(`${u.origin}/api/bye?token=${u.searchParams.get('token')}`, { method: 'POST' });
    assert.equal(await p, 0);
    await assert.rejects(fetch(`${u.origin}/api/state?token=${u.searchParams.get('token')}`));
  });
});

describe('ui root rule', () => {
  it('installs the root rule with any install and never uninstalls it', async () => {
    const dry = await post({ tools: ['codex'], install: ['alpha'], dryRun: true });
    assert.ok(dry.plan.some((l) => /root|rule/i.test(l)), dry.plan.join('\n'));
    const un = await post({ tools: ['codex'], uninstall: ['root-rule'], dryRun: true });
    assert.equal(un.changed, 0);
  });
});
