import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/runtime/service.js';
import { createApp } from '../src/web/server.js';
import { acquireServiceLock } from '../src/runtime/service-lock.js';

test('service ownership prevents a second startup from recovering live tasks', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cheese-lock-'));
  try {
    const release = acquireServiceLock(directory);
    assert.throws(() => acquireServiceLock(directory), /正在使用/);
    release();
    const releaseAgain = acquireServiceLock(directory);
    release();
    assert.throws(() => acquireServiceLock(directory), /正在使用/);
    releaseAgain();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('local API rejects hostile hosts, malformed bodies, invalid pagination and unknown routes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cheese-boundary-'));
  try {
    const app = createApp(new Runtime(directory));
    assert.equal((await app.request('http://rebind.example/api/v1/status')).status, 403);
    assert.equal((await app.request('/api/v1/status', { headers: { host: 'rebind.example' } })).status, 403);
    for (const body of ['{', 'null', '[]']) {
      const response = await app.request('/api/v1/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      assert.equal(response.status, 400);
    }
    assert.equal((await app.request('/api/v1/sessions?offset=NaN')).status, 400);
    assert.equal((await app.request('/api/v1/sessions?limit=-1')).status, 400);
    const missing = await app.request('/api/v1/unknown');
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get('content-type') || '', /json/);
    const oversized = await app.request('/api/v1/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'a'.repeat(1_048_576) }) });
    assert.equal(oversized.status, 413);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('SSE cursor reconnect fills missed output without replaying the task', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cheese-sse-'));
  let finish = () => {};
  let executions = 0;
  const runtime = new Runtime(directory, async ({ emit, messages }) => {
    executions++;
    emit({ type: 'text', text: 'first' });
    await new Promise<void>(resolve => { finish = resolve; });
    emit({ type: 'text', text: 'second' });
    return [...messages, { role: 'assistant', content: 'firstsecond' }];
  });
  try {
    const run = runtime.submit(runtime.createSession(runtime.addWorkspace(directory).id).id, 'work', 'sse');
    const app = createApp(runtime);
    const first = await app.request(`/api/v1/runs/${run.id}/events?after=2`);
    const reader = first.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /first/);
    await reader.cancel();
    assert.equal(run.status, 'running');
    finish(); await runtime.idle();
    const second = await app.request(`/api/v1/runs/${run.id}/events`, { headers: { 'last-event-id': '3' } });
    const replay = second.body!.getReader();
    assert.match(new TextDecoder().decode((await replay.read()).value), /second/);
    await replay.cancel();
    assert.equal(executions, 1);
  } finally { finish(); await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
});
