import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/runtime/service.js';

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
