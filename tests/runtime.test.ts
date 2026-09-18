import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/runtime/service.js';
import { createApp } from '../src/web/server.js';

test('accepted messages persist, followups retain context and duplicate submissions execute once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cheese-test-'));
  try {
    const runtime = new Runtime(dir, async ({ messages }) => [...messages, { role: 'assistant', content: `messages:${messages.length}` }]);
    const workspace = runtime.addWorkspace(dir);
    const session = runtime.createSession(workspace.id);
    const first = runtime.submit(session.id, 'hello', 'first');
    assert.equal(runtime.submit(session.id, 'hello', 'first').id, first.id);
    await runtime.idle();
    assert.equal(runtime.session(session.id).messages.at(-1)?.content, 'messages:1');
    runtime.submit(session.id, 'again', 'second');
    await runtime.idle();
    assert.equal(runtime.session(session.id).messages.at(-1)?.content, 'messages:3');
    const recovered = new Runtime(dir, async ({ messages }) => messages);
    assert.equal(recovered.session(session.id).messages.length, 4);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('API rejects cross-origin writes and unknown sessions without executing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cheese-api-'));
  try {
    const runtime = new Runtime(dir, async () => { throw new Error('must not execute'); });
    const app = createApp(runtime);
    const denied = await app.request('/api/v1/sessions', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(denied.status, 403);
    assert.equal((await app.request('/api/v1/sessions/missing')).status, 404);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
