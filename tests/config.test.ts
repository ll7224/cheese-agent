import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureConfig, resolveConfig } from '../src/runtime/config.js';

test('directory overrides preserve false, path origin and old session parameters without storing credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cheese-config-'));
  try {
    const project = join(dir, 'project'); mkdirSync(project);
    writeFileSync(join(dir, 'cheese-agent.config.json'), JSON.stringify({ model: { provider: 'custom', name: 'old', apiKey: 'private-value' }, memory: { dataDir: './memory' }, rag: { enabled: true } }));
    const local = join(project, 'cheese-agent.config.json');
    writeFileSync(local, JSON.stringify({ rag: { enabled: false }, model: { name: 'project-model' } }));
    const snapshot = captureConfig(dir, project);
    assert.equal(snapshot.values.rag.enabled, false);
    assert.equal(snapshot.values.memory.dataDir, join(dir, 'memory'));
    assert.equal(JSON.stringify(snapshot).includes('private-value'), false);
    writeFileSync(local, JSON.stringify({ model: { name: 'new-model' } }));
    assert.equal(resolveConfig(snapshot).model.name, 'project-model');
    assert.equal(resolveConfig(snapshot).model.apiKey, 'private-value');
    assert.equal(captureConfig(dir, project).values.model.name, 'new-model');
    writeFileSync(join(dir, 'cheese-agent.config.json'), '{}');
    assert.throws(() => resolveConfig(snapshot), /凭据/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
