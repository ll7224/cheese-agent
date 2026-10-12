import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/runtime/service.js';
import { createApp } from '../src/web/server.js';

test('directory picker is origin protected, single flight, cancellable and reuses workspace validation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cheese-picker-'));
  try {
    const runtime = new Runtime(join(directory, 'state'));
    let finish: (path: string | null) => void = () => {};
    let calls = 0;
    const app = createApp(runtime, () => { calls++; return new Promise(resolve => { finish = resolve; }); });
    const post = (origin = 'http://localhost') => app.request('/api/v1/workspaces/pick-directory', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: '{}' });
    assert.equal((await post('https://other.example')).status, 403);
    assert.equal(calls, 0);
    const first = post();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await post()).status, 409);
    assert.equal(calls, 1);
    finish(null);
    assert.deepEqual(await (await first).json(), { path: null });
    assert.equal(runtime.listWorkspaces().length, 0);
    const second = post();
    await new Promise(resolve => setImmediate(resolve));
    finish(directory);
    const selected = await (await second).json();
    assert.equal(selected.path, directory);
    const connected = await app.request('/api/v1/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(selected) });
    assert.equal(connected.status, 201);
    assert.equal(runtime.listWorkspaces().length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('picker failure releases admission so users can retry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cheese-picker-error-'));
  try {
    let calls = 0;
    const app = createApp(new Runtime(directory), async () => { if (++calls === 1) throw new Error('unavailable'); return null; });
    const post = () => app.request('/api/v1/workspaces/pick-directory', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal((await post()).status, 500);
    assert.deepEqual(await (await post()).json(), { path: null });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
