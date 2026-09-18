import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
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

test('workspace aliases deduplicate and unavailable directories retain history but reject new sessions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cheese-dirs-'));
  try {
    const project = join(dir, 'project');
    mkdirSync(project);
    symlinkSync(project, join(dir, 'alias'));
    const runtime = new Runtime(join(dir, 'state'), async ({ cwd, messages }) => [...messages, { role: 'assistant', content: readFileSync(join(cwd, 'same.txt'), 'utf8') }]);
    const workspace = runtime.addWorkspace(project);
    assert.equal(runtime.addWorkspace(join(dir, 'alias')).id, workspace.id);
    const session = runtime.createSession(workspace.id);
    writeFileSync(join(project, 'same.txt'), 'project contents');
    runtime.submit(session.id, 'read', 'read');
    await runtime.idle();
    assert.equal(runtime.session(session.id).messages.at(-1)?.content, 'project contents');
    rmSync(project, { recursive: true });
    assert.equal(runtime.listWorkspaces()[0].available, false);
    assert.throws(() => runtime.createSession(workspace.id), /不可用/);
    assert.equal(runtime.session(session.id).messages.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('execution events persist with ordered cursors and redact credential fields', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cheese-events-'));
  try {
    const runtime = new Runtime(dir, async ({ messages, emit }) => {
      emit({ type: 'text', text: 'hello', attempt: 1 });
      emit({ type: 'tool-start', toolCallId: 'one', input: { apiKey: 'do-not-store' } });
      emit({ type: 'tool-result', toolCallId: 'one', output: 'result' });
      return [...messages, { role: 'assistant', content: 'hello' }];
    });
    const session = runtime.createSession(runtime.addWorkspace(dir).id);
    const run = runtime.submit(session.id, 'hello', 'events');
    await runtime.idle();
    const events = runtime.events(run.id, 0);
    assert.deepEqual(events.map(event => event.sequence), [1, 2, 3, 4, 5, 6]);
    assert.equal(JSON.stringify(events).includes('do-not-store'), false);
    assert.equal(runtime.events(run.id, 3).length, 3);
    const restored = new Runtime(dir);
    assert.equal(restored.events(run.id, 0).length, 6);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('four same-directory sessions run at most three tasks and advance FIFO without serializing the directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cheese-queue-'));
  const releases: Array<() => void> = [];
  try {
    const runtime = new Runtime(dir, async ({ messages }) => { await new Promise<void>(resolve => releases.push(resolve)); return messages; });
    const workspace = runtime.addWorkspace(dir);
    const sessions = Array.from({ length: 4 }, () => runtime.createSession(workspace.id));
    const runs = sessions.map((session, index) => runtime.submit(session.id, 'work', `key-${index}`));
    assert.deepEqual(runs.map(run => run.status), ['running', 'running', 'running', 'queued']);
    assert.equal(releases.length, 3);
    assert.throws(() => runtime.submit(sessions[0].id, 'again', 'other'), /待完成/);
    releases[0]();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(runs[3].status, 'running');
    releases.slice(1).forEach(release => release());
    await runtime.idle();
    assert.equal(runtime.status().active, 0);
  } finally { releases.forEach(release => release()); rmSync(dir, { recursive: true, force: true }); }
});
