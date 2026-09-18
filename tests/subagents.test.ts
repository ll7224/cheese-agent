import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnParallel } from '../src/agents/spawn.js';
import { SubAgentRegistry } from '../src/agents/registry.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createMockModel } from '../src/mock-model.js';
import { Pool } from '../src/runtime/pool.js';

test('subtasks across parents share a permit pool and all queued tasks eventually complete', async () => {
  const pool = new Pool(1);
  const events: any[] = [];
  const context = () => ({ model: createMockModel(), registry: new ToolRegistry(), agentRegistry: new SubAgentRegistry({ maxConcurrent: 1 }), buildSystem: () => 'Reply briefly', currentDepth: 0, acquireChild: () => pool.acquire(), emit: (event: any) => events.push(event) });
  const results = await Promise.all([
    spawnParallel([{ task: 'hello' }, { task: 'hello' }], context()),
    spawnParallel([{ task: 'hello' }], context()),
  ]);
  assert.equal(results.flat().filter(result => !result.result.includes('拒绝')).length, 3);
  assert.equal(events.filter(event => event.type === 'child-status' && event.status === 'completed').length, 3);
  assert.equal(pool.active, 0);
});
