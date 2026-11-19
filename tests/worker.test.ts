import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/runtime/service.js';
import { createServer } from 'node:http';
import { createApp } from '../src/web/server.js';

test('real worker streams a mock response and stops without affecting a second worker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cheese-worker-'));
  let runtime: Runtime | undefined;
  try {
    writeFileSync(join(dir, 'cheese-agent.config.json'), JSON.stringify({ model: { provider: 'mock' }, rag: { enabled: false } }));
    runtime = new Runtime(join(dir, 'state'));
    const workspace = runtime.addWorkspace(dir);
    const first = runtime.createSession(workspace.id);
    const second = runtime.createSession(workspace.id);
    const stopped = runtime.submit(first.id, '你好', 'one');
    const completed = runtime.submit(second.id, '你好', 'two');
    runtime.subscribe(stopped.id, event => { if (event.type === 'text') runtime!.stop(stopped.id); });
    await runtime.idle();
    assert.equal(stopped.status, 'cancelled', stopped.error);
    assert.equal(completed.status, 'completed', completed.error);
    assert.match(JSON.stringify(runtime.session(second.id).messages), /模拟/);
  } finally { await runtime?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('real worker budget stop persists error and tool history for API and subsequent reload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cheese-worker-stop-'));
  let runtime: Runtime | undefined;
  let restored: Runtime | undefined;
  let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the fixture request */ }
    requests++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: unknown, finish_reason: string | null, usage?: unknown) => response.write(`data: ${JSON.stringify({ id: 'stop-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }], usage })}\n\n`);
    chunk({ tool_calls: [{ index: 0, id: 'read-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"sample.txt"}' } }] }, null);
    chunk({}, 'tool_calls', { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 });
    response.end('data: [DONE]\n\n');
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    writeFileSync(join(dir, 'sample.txt'), 'recorded tool result');
    writeFileSync(join(dir, 'cheese-agent.config.json'), JSON.stringify({ model: { provider: 'openai', name: 'fixture', apiKey: 'fixture-only', baseURL: `http://127.0.0.1:${address.port}/v1` }, execution: { tokenBudget: 100 }, rag: { enabled: false }, cron: { enabled: false } }));
    runtime = new Runtime(join(dir, 'state'));
    const session = runtime.createSession(runtime.addWorkspace(dir).id);
    const run = runtime.submit(session.id, 'read the file', 'stop');
    await runtime.idle();
    assert.equal(run.status, 'failed');
    assert.match(run.error || '', /Token 预算上限/);
    assert.equal(requests, 1);
    assert.equal(runtime.session(session.id).messages.at(-1)?.role, 'tool');
    assert.match(JSON.stringify(runtime.session(session.id).messages), /recorded tool result/);
    const stop = runtime.events(run.id).find(event => event.type === 'execution-stopped');
    assert.equal(stop?.reason, 'token-budget');
    assert.equal(stop?.budget, 100);
    const payload = await (await createApp(runtime).request(`/api/v1/sessions/${session.id}`)).json() as any;
    assert.equal(payload.runs[0].status, 'failed');
    assert.match(payload.runs[0].error, /Token 预算上限/);
    await runtime.close(); runtime = undefined;
    restored = new Runtime(join(dir, 'state'));
    assert.equal(restored.state.runs[0].status, 'failed');
    assert.equal(restored.session(session.id).messages.at(-1)?.role, 'tool');
  } finally {
    await runtime?.close(); await restored?.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
