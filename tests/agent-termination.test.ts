import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import type { ModelMessage } from 'ai';
import { agentLoop } from '../src/agent/loop.js';
import { AgentStoppedError } from '../src/agent/termination.js';
import { ToolRegistry } from '../src/tools/registry.js';

function fixture(mode: 'text' | 'tool' | 'empty' | 'length', input = 10, cached = 0) {
  let calls = 0;
  const model = new MockLanguageModelV3({ doStream: async () => {
    calls++;
    return { stream: simulateReadableStream({ initialDelayInMs: null, chunkDelayInMs: null, chunks: [
      { type: 'stream-start', warnings: [] },
      ...(mode === 'tool' ? [{ type: 'tool-call', toolCallId: `call-${calls}`, toolName: 'read_file', input: '{"path":"file.txt"}' }] :
        mode === 'empty' ? [] : [
          { type: 'text-start', id: 'answer' },
          { type: 'text-delta', id: 'answer', delta: '结果内容' },
          { type: 'text-end', id: 'answer' },
        ]),
      { type: 'finish', finishReason: { unified: mode === 'tool' ? 'tool-calls' : mode === 'length' ? 'length' : 'stop', raw: undefined },
        usage: { inputTokens: { total: input, noCache: input - cached, cacheRead: cached, cacheWrite: undefined },
          outputTokens: { total: 10, text: 10, reasoning: undefined } } },
    ] as any }) };
  } });
  const registry = new ToolRegistry();
  registry.register({ name: 'read_file', description: 'read fixture', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, execute: async () => 'file contents' });
  const messages: ModelMessage[] = [{ role: 'user', content: 'work' }];
  const events: any[] = [];
  return { model, registry, messages, events, calls: () => calls, emit: (event: any) => events.push(event) };
}

test('step limit is an explicit stop and preserves completed tool messages', async () => {
  const f = fixture('tool');
  await assert.rejects(agentLoop(f.model, f.registry, f.messages, 'fixture', undefined, { maxSteps: 1, emit: f.emit }),
    (error: any) => error instanceof AgentStoppedError && error.reason === 'step-limit');
  assert.equal(f.calls(), 1);
  assert.equal(f.messages.at(-1)?.role, 'tool');
  assert.equal(f.events.at(-1).reason, 'step-limit');
});

test('budget stop reports its reason without requesting an extra paid summary', async () => {
  const f = fixture('tool', 500001);
  await assert.rejects(agentLoop(f.model, f.registry, f.messages, 'fixture', undefined, { emit: f.emit }), /Token 预算上限/);
  assert.equal(f.calls(), 1);
  assert.equal(f.events.at(-1).reason, 'token-budget');
  assert.equal(f.events.at(-1).used, 500011);
});

test('cached input is not counted twice when enforcing the budget', async () => {
  const f = fixture('tool', 300000, 250000);
  await assert.rejects(agentLoop(f.model, f.registry, f.messages, 'fixture', undefined, { maxSteps: 1, emit: f.emit }),
    (error: any) => error.reason === 'step-limit');
});

test('configured budget counts cumulative step usage, not a single context window', async () => {
  const f = fixture('tool', 20);
  await assert.rejects(agentLoop(f.model, f.registry, f.messages, 'fixture', undefined,
    { tokenBudget: 50, emit: f.emit } as any), (error: any) => error.reason === 'token-budget');
  assert.equal(f.calls(), 2);
  assert.equal(f.events.at(-1).used, 60);
  assert.equal(f.events.at(-1).budget, 50);
});

test('empty output and truncated model output are not successful replies', async () => {
  for (const [mode, reason] of [['empty', 'empty-response'], ['length', 'model-length']] as const) {
    const f = fixture(mode);
    await assert.rejects(agentLoop(f.model, f.registry, f.messages, 'fixture', undefined, { emit: f.emit }),
      (error: any) => error.reason === reason);
    assert.equal(f.events.at(-1).reason, reason);
  }
});

test('normal final reply at the last step is still successful', async () => {
  const f = fixture('text');
  await agentLoop(f.model, f.registry, f.messages, 'fixture', undefined, { maxSteps: 1, emit: f.emit });
  assert.equal(f.events.filter(e => e.type === 'execution-stopped').length, 0);
  assert.match(JSON.stringify(f.messages.at(-1)), /结果内容/);
});

test('loop circuit breaker stops explicitly rather than completing silently', async () => {
  const f = fixture('tool');
  await assert.rejects(agentLoop(f.model, f.registry, f.messages, 'fixture', undefined, { maxSteps: 15, emit: f.emit }),
    (error: any) => error.reason === 'loop-detected');
  assert.equal(f.calls(), 9);
  assert.equal(f.messages.at(-1)?.role, 'tool');
});
