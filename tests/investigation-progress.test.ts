import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import type { ModelMessage } from 'ai';
import { agentLoop } from '../src/agent/loop.js';
import { ToolRegistry } from '../src/tools/registry.js';

async function investigate(script: Array<{ name?: string; output: string }>) {
  let call = 0;
  const requests: any[][] = [];
  const events: any[] = [];
  const model = new MockLanguageModelV3({ doStream: async options => {
    requests.push(structuredClone(options.prompt));
    const item = script[call++];
    const chunks = item ? [
      { type: 'tool-call', toolCallId: `call-${call}`, toolName: item.name || 'grep', input: JSON.stringify({ query: String(call - 1) }) },
    ] : [
      { type: 'text-start', id: 'answer' },
      { type: 'text-delta', id: 'answer', delta: '调查结果已交付' },
      { type: 'text-end', id: 'answer' },
    ];
    return { stream: simulateReadableStream({ initialDelayInMs: null, chunkDelayInMs: null, chunks: [
      { type: 'stream-start', warnings: [] }, ...chunks,
      { type: 'finish', finishReason: { unified: item ? 'tool-calls' : 'stop', raw: undefined },
        usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 10, text: 10, reasoning: undefined } } },
    ] as any }) };
  } });
  const registry = new ToolRegistry();
  for (const name of ['grep', 'edit_file']) {
    registry.register({ name, description: name, isReadOnly: name === 'grep',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      execute: async ({ query }) => script[Number(query)].output });
  }
  const messages: ModelMessage[] = [{ role: 'user', content: '定位并交付，无法定位时说明阻塞。' }];
  await agentLoop(model, registry, messages, 'fixture', undefined,
    { maxSteps: script.length + 1, emit: event => events.push(event) });
  return { messages, events, requests };
}

test('repeated evidence across different search queries prompts reassessment without stopping the task', async () => {
  const outputs = ['source-A', 'source-B', 'source-C', 'source-A', 'source-D', 'source-B', 'source-E', 'source-C'];
  const result = await investigate(outputs.map(output => ({ output })));
  const warnings = result.events.filter(event => event.type === 'execution-warning' && event.reason === 'repeated-evidence');
  assert.equal(warnings.length, 1);
  const prompt = result.requests.at(-1)!;
  const reminderIndex = prompt.findIndex(message => message.role === 'user' && JSON.stringify(message.content).includes('重复取证'));
  assert.ok(reminderIndex > 0, 'the next model request must receive the reassessment reminder');
  assert.equal(prompt[reminderIndex - 1].role, 'tool', 'reminder must follow the complete tool exchange');
  assert.match(JSON.stringify(result.messages.at(-1)), /调查结果已交付/);
  assert.equal(result.events.filter(event => event.type === 'execution-stopped').length, 0);
});

test('long investigations with new evidence do not trigger a read-count warning', async () => {
  const result = await investigate(Array.from({ length: 12 }, (_, index) => ({ output: `new-source-${index}` })));
  assert.equal(result.events.filter(event => event.type === 'execution-warning').length, 0);
});

test('a modifying tool resets repeated-evidence tracking so validation can revisit earlier evidence', async () => {
  const result = await investigate([
    ...['A', 'B', 'C', 'A', 'D', 'B'].map(output => ({ output })),
    { name: 'edit_file', output: 'changed' },
    ...['C', 'A', 'B', 'D'].map(output => ({ output })),
  ]);
  assert.equal(result.events.filter(event => event.type === 'execution-warning').length, 0);
});
