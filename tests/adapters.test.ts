import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/runtime/service.js';
import { ChannelGateway } from '../src/channels/gateway.js';
import type { IncomingMessage } from '../src/channels/types.js';

test('Channel and Cron share Web admission and retain separate source conversations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cheese-adapters-'));
  const releases: Array<() => void> = [];
  const replies: string[] = [];
  let receive: (message: IncomingMessage) => void = () => {};
  const runtime = new Runtime(join(directory, 'state'), async ({ messages }) => {
    await new Promise<void>(resolve => releases.push(resolve));
    return [...messages, { role: 'assistant', content: 'done' }];
  }, { maxConcurrent: 1 });
  try {
    writeFileSync(join(directory, 'cheese-agent.config.json'), JSON.stringify({ model: { provider: 'mock' }, cron: { enabled: true } }));
    const workspace = runtime.addWorkspace(directory);
    const gateway = new ChannelGateway({ run: (name, message) => runtime.runPrompt(workspace.id, message.text, `${name}:${message.channelId}:${message.senderId}`) });
    gateway.register({ name: 'fixture', description: 'local fixture', start() {}, stop() {}, onMessage(handler) { receive = handler; }, async send(message) { replies.push(message.text); } });
    runtime.submit(runtime.createSession(workspace.id).id, 'web', 'web');
    receive({ channelId: 'one', senderId: 'user', senderName: 'user', text: 'channel' });
    await runtime.manageCron(workspace.id, { action: 'add', id: 'job', name: 'fixture', schedule: 'every 1h', prompt: 'cron' });
    assert.match(String(await runtime.manageCron(workspace.id, { action: 'run', id: 'job' })), /已提交/);
    assert.deepEqual(runtime.state.runs.map(run => run.status), ['running', 'queued', 'queued']);
    for (let index = 0; index < 3; index++) {
      releases[index]();
      await new Promise(resolve => setImmediate(resolve));
    }
    await runtime.idle();
    assert.deepEqual(replies, ['done']);
    const count = runtime.state.sessions.length;
    receive({ channelId: 'one', senderId: 'user', senderName: 'user', text: 'followup' });
    assert.equal(runtime.state.sessions.length, count);
    releases[3]();
    await runtime.idle();
  } finally { releases.forEach(release => release()); await runtime.close(); rmSync(directory, { recursive: true, force: true }); }
});
