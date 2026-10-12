import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/runtime/service.js';

test('known credentials split between text chunks never reach persisted events', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cheese-redaction-'));
  try {
    writeFileSync(join(directory, 'cheese-agent.config.json'), JSON.stringify({ model: { provider: 'mock', apiKey: 'private-secret-value' } }));
    const runtime = new Runtime(join(directory, 'state'), async ({ messages, emit }) => {
      emit({ type: 'text', text: 'before private-', step: 1 });
      emit({ type: 'text', text: 'secret-', step: 1 });
      emit({ type: 'text', text: 'value after', step: 1 });
      return [...messages, { role: 'assistant', content: 'before private-secret-value after' }];
    });
    const run = runtime.submit(runtime.createSession(runtime.addWorkspace(directory).id).id, 'hello', 'redact');
    await runtime.idle();
    const streamed = runtime.events(run.id).filter(event => event.type === 'text').map(event => event.text).join('');
    assert.equal(streamed, 'before [已隐藏] after');
    assert.equal(readFileSync(join(directory, 'state/state.json'), 'utf8').includes('private-secret-value'), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('recovery from a corrupt snapshot does not overwrite the good backup', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cheese-backup-'));
  try {
    const runtime = new Runtime(directory);
    const workspace = runtime.addWorkspace(directory);
    runtime.createSession(workspace.id);
    const backup = readFileSync(join(directory, 'state.json.bak'), 'utf8');
    writeFileSync(join(directory, 'state.json'), '{broken');
    const recovered = new Runtime(directory);
    recovered.createSession(workspace.id);
    assert.equal(readFileSync(join(directory, 'state.json.bak'), 'utf8'), backup);
    writeFileSync(join(directory, 'state.json'), JSON.stringify({ sessions: null }));
    assert.equal(new Runtime(directory).listWorkspaces().length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
