import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Runtime } from '../src/runtime/service.js';

test('real workers execute tools in each directory, share child slots and terminate shell trees', { timeout: 30000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cheese-tools-'));
  let runtime: Runtime | undefined;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    const prompt = String(input.messages.find((message: any) => message.role === 'user')?.content || '');
    const results = input.messages.filter((message: any) => message.role === 'tool');
    let calls: Array<{ name: string; arguments: unknown }> = [];
    if (!results.length && prompt === 'files') calls = [
      { name: 'read_file', arguments: { path: 'same.txt' } },
      { name: 'write_file', arguments: { path: 'written.txt', content: 'persisted' } },
      { name: 'bash', arguments: { command: 'pwd' } },
    ];
    if (!results.length && prompt === 'spawn') calls = [{ name: 'spawn_agent', arguments: { tasks: ['child-one', 'child-two'] } }];
    if (!results.length && prompt === 'spawn-sleep') calls = [{ name: 'spawn_agent', arguments: { tasks: ['sleep', 'child-two'] } }];
    if (!results.length && prompt === 'sleep') calls = [{ name: 'bash', arguments: { command: 'echo $$ > shell.pid; exec sleep 25' } }];
    if (!results.length && prompt === 'cron') calls = [{ name: 'cron_manage', arguments: { action: 'add', id: 'from-worker', name: 'fixture', schedule: 'every 1h', prompt: 'scheduled' } }];
    if (prompt.startsWith('child-')) await delay(150);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const delta = calls.length ? { tool_calls: calls.map((call, index) => ({ index, id: `call-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : { content: results.length ? results.map((message: any) => message.content).join('\n') : 'fixture done' };
    const chunk = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
    chunk({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] });
    chunk({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
    response.end('data: [DONE]\n\n');
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const config = { model: { provider: 'openai', name: 'fixture', apiKey: 'fixture-only-key', baseURL: `http://127.0.0.1:${address.port}/v1` }, rag: { enabled: false }, cron: { enabled: true } };
    runtime = new Runtime(join(directory, 'state'), undefined, { maxChildren: 1 });
    const workspaces = ['alpha', 'beta'].map(name => {
      const path = join(directory, name); mkdirSync(path);
      writeFileSync(join(path, 'same.txt'), name);
      writeFileSync(join(path, 'cheese-agent.config.json'), JSON.stringify(config));
      return runtime!.addWorkspace(path);
    });
    const runs = workspaces.map(workspace => runtime!.submit(runtime!.createSession(workspace.id).id, 'files', 'files'));
    await runtime.idle();
    for (const [index, run] of runs.entries()) {
      assert.equal(run.status, 'completed', run.error);
      const events = runtime.events(run.id);
      assert.equal(events.filter(event => event.type === 'tool-result').length, 3);
      assert.equal(events.find(event => event.type === 'tool-result' && event.name === 'read_file')?.output, workspaces[index].name);
      assert.match(String(events.find(event => event.type === 'tool-result' && event.name === 'bash')?.output), new RegExp(workspaces[index].path));
      assert.equal(readFileSync(join(workspaces[index].path, 'written.txt'), 'utf8'), 'persisted');
    }
    let activeChildren = 0;
    let peak = 0;
    const spawned = workspaces.map(workspace => runtime!.submit(runtime!.createSession(workspace.id).id, 'spawn', 'spawn'));
    const unsubscribers = spawned.map(run => runtime!.subscribe(run.id, event => {
      if (event.type !== 'child-status') return;
      if (event.status === 'running') { activeChildren++; peak = Math.max(peak, activeChildren); }
      if (event.status === 'completed') activeChildren--;
    }));
    await runtime.idle(); unsubscribers.forEach(unsubscribe => unsubscribe());
    assert.equal(peak, 1); assert.equal(activeChildren, 0);
    for (const run of spawned) {
      assert.equal(run.status, 'completed', run.error);
      assert.equal(runtime.events(run.id).filter(event => event.type === 'child-status' && event.status === 'completed').length, 2);
    }
    const cronRun = runtime.submit(runtime.createSession(workspaces[0].id).id, 'cron', 'cron');
    await runtime.idle();
    assert.equal(cronRun.status, 'completed', cronRun.error);
    assert.match(String(await runtime.manageCron(workspaces[0].id, { action: 'list' })), /from-worker/);
    const stopping = runtime.submit(runtime.createSession(workspaces[0].id).id, 'spawn-sleep', 'sleep');
    const other = runtime.submit(runtime.createSession(workspaces[1].id).id, 'hello', 'hello');
    const pidFile = join(workspaces[0].path, 'shell.pid');
    const deadline = Date.now() + 8000;
    while (!existsSync(pidFile) && Date.now() < deadline) await delay(25);
    assert.ok(existsSync(pidFile), stopping.error || 'shell did not start');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    runtime.stop(stopping.id);
    await runtime.idle();
    assert.equal(stopping.status, 'cancelled');
    assert.equal(runtime.events(stopping.id).filter(event => event.type === 'child-status' && event.status === 'cancelled').length, 2);
    assert.equal(runtime.status().children.active, 0);
    assert.equal(other.status, 'completed', other.error);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal(readFileSync(join(workspaces[0].path, 'written.txt'), 'utf8'), 'persisted');
  } finally {
    await runtime?.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
