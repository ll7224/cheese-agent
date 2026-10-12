import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/runtime/service.js';

for (const shared of [false, true]) {
  test(`multiple workspaces can chat with ${shared ? 'conflicting explicit' : 'inherited'} Cron storage`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cheese-cron-workspaces-')));
    const runtime = new Runtime(join(directory, 'state'), async execution => [...execution.messages, { role: 'assistant', content: 'ok' }], { configDir: directory });
    try {
      writeFileSync(join(directory, 'cheese-agent.config.json'), JSON.stringify({ model: { provider: 'mock' }, cron: { enabled: true, dataDir: '.' } }));
      const first = runtime.addWorkspace(directory);
      runtime.enableSchedules();
      const project = join(directory, 'project'); mkdirSync(project);
      if (shared) writeFileSync(join(project, 'cheese-agent.config.json'), JSON.stringify({ cron: { dataDir: directory } }));
      const second = runtime.addWorkspace(project);
      for (const workspace of [first, second]) {
        const session = runtime.createSession(workspace.id);
        const run = runtime.submit(session.id, 'hello', 'hello');
        await runtime.idle();
        assert.equal(run.status, 'completed', run.error);
      }
      await runtime.manageCron(first.id, { action: 'add', id: 'first-only', name: 'first', schedule: 'every 1h', prompt: 'hello' });
      if (shared) {
        await assert.rejects(runtime.manageCron(second.id, { action: 'list' }), /Cron 数据目录已绑定/);
      } else {
        assert.doesNotMatch(String(await runtime.manageCron(second.id, { action: 'list' })), /first-only/);
        await runtime.manageCron(second.id, { action: 'add', id: 'second-only', name: 'second', schedule: 'every 1h', prompt: 'hello' });
        assert.doesNotMatch(String(await runtime.manageCron(first.id, { action: 'list' })), /second-only/);
      }
    } finally {
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
