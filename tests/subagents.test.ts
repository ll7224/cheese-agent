import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnParallel } from '../src/agents/spawn.js';
import { SubAgentRegistry } from '../src/agents/registry.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createMockModel } from '../src/mock-model.js';
import { Pool } from '../src/runtime/pool.js';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';

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

test('child loop inherits its configured per-loop token budget', async () => {
  let calls = 0;
  const model = new MockLanguageModelV3({ doStream: async () => {
    calls++;
    return { stream: simulateReadableStream({ initialDelayInMs: null, chunkDelayInMs: null, chunks: [
      { type: 'stream-start', warnings: [] },
      { type: 'tool-call', toolCallId: `read-${calls}`, toolName: 'read_file', input: '{}' },
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      } },
    ] as any }) };
  } });
  const registry = new ToolRegistry();
  registry.register({ name: 'read_file', description: 'fixture', parameters: { type: 'object', properties: {} }, execute: async () => 'fixture result' });
  const events: any[] = [];
  const [result] = await spawnParallel([{ task: 'read fixture' }], {
    model, registry, agentRegistry: new SubAgentRegistry({}), buildSystem: () => 'fixture', currentDepth: 0,
    tokenBudget: 5, emit: event => events.push(event),
  } as any);
  assert.match(result.result, /Token 预算上限/);
  assert.equal(calls, 1);
  assert.equal(events.find(event => event.type === 'execution-stopped')?.budget, 5);
});
