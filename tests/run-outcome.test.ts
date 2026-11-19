import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore Browser module is intentionally shared with these data-contract tests.
import { conversationEntries, currentRunLabel } from '../web/run-outcome.js';

test('old completed tool-only runs show a notice, including after a later successful turn', () => {
  const session = {
    messages: [
      { role: 'user', content: 'work' },
      { role: 'assistant', content: [{ type: 'tool-call', toolName: 'bash' }] },
      { role: 'tool', content: [] },
      { role: 'user', content: 'follow up' },
      { role: 'assistant', content: 'Done' },
    ],
    runs: [{ id: 'old', status: 'completed', messageOffset: 1 }, { id: 'new', status: 'completed', messageOffset: 4 }],
  };
  const entries = conversationEntries(session);
  assert.deepEqual(entries.map((entry: any) => entry.type), ['message', 'outcome', 'message', 'message']);
  assert.equal(entries[1].runId, 'old');
  assert.match(entries[1].message, /不能据此确认任务完成/);
  assert.equal(currentRunLabel(session, session.runs[0]), '未返回结果');
  assert.equal(currentRunLabel(session, session.runs[1]), null);
});

test('failed runs retain error next to partial output, active/successful runs have no notice', () => {
  const messages = [{ role: 'user', content: 'work' }, { role: 'assistant', content: '部分结果' }];
  const failure = { id: 'run', status: 'failed', messageOffset: 1, error: '<script>alert(1)</script> upstream failed' };
  const entries = conversationEntries({ messages, runs: [failure] });
  assert.equal(entries.at(-1).message, failure.error);
  assert.equal(entries.at(-1).tone, 'error');
  for (const status of ['running', 'completed']) {
    assert.equal(conversationEntries({ messages, runs: [{ ...failure, status, error: undefined }] }).length, 2);
  }
});

test('empty and reasoning-only terminal replies get a notice; cancellation and recovery are visible', () => {
  for (const status of ['completed', 'cancelled', 'interrupted']) {
    const entries = conversationEntries({ messages: [{ role: 'user', content: 'work' }, { role: 'assistant', content: '', reasoning: 'thinking' }], runs: [{ id: 'run', status, messageOffset: 1 }] });
    assert.equal(entries.at(-1).type, 'outcome');
  }
});
