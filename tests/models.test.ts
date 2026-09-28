import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelStore } from '../src/runtime/model-store.js';
import { Runtime } from '../src/runtime/service.js';
import { createApp } from '../src/web/server.js';

test('ModelStore persists models, masks API keys and manages defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cheese-model-store-'));
  try {
    const store = new ModelStore(dir);
    assert.equal(store.list().length, 0);

    // Save first model (becomes default automatically)
    const m1 = store.saveModel({
      label: 'DeepSeek-V3',
      provider: 'deepseek',
      name: 'deepseek-chat',
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: 'sk-1234567890abcdef'
    });
    assert.equal(m1.isDefault, true);
    assert.equal(m1.maskedKey, 'sk-****cdef');
    assert.equal(m1.hasKey, true);

    // Save second model
    const m2 = store.saveModel({
      label: 'Claude 3.7',
      provider: 'anthropic',
      name: 'claude-3-7-sonnet',
      baseURL: 'https://api.proxy.com/v1',
      apiKey: 'sk-ant-987654321',
      isDefault: true
    });
    assert.equal(m2.isDefault, true);
    // m1 is no longer default
    assert.equal(store.get(m1.id)?.isDefault, false);
    assert.equal(store.getDefault()?.id, m2.id);

    // Update m1 without re-providing apiKey
    const updatedM1 = store.saveModel({
      id: m1.id,
      label: 'DeepSeek Chat (Updated)',
      provider: 'deepseek',
      name: 'deepseek-chat',
      baseURL: 'https://api.deepseek.com/v1'
    });
    assert.equal(updatedM1.label, 'DeepSeek Chat (Updated)');
    assert.equal(store.get(m1.id)?.apiKey, 'sk-1234567890abcdef');

    // Delete m2, m1 becomes default
    assert.equal(store.deleteModel(m2.id), true);
    assert.equal(store.list().length, 1);
    assert.equal(store.getDefault()?.id, m1.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Model API endpoints manage models and isolate sessions with modelId', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cheese-model-api-'));
  try {
    const runtime = new Runtime(dir, undefined, { configDir: dir, modelDir: dir });
    const app = createApp(runtime);

    // 1. Presets endpoint
    const presetsRes = await app.request('/api/v1/models/presets');
    assert.equal(presetsRes.status, 200);
    const presets = await presetsRes.json() as any;
    assert.ok(presets.deepseek);
    assert.ok(presets.openai);

    // 2. Add model via API
    const addRes = await app.request('/api/v1/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        label: 'GPT-4o Test',
        provider: 'openai',
        name: 'gpt-4o',
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'sk-my-secret-key-123',
        isDefault: true
      })
    });
    assert.equal(addRes.status, 201);
    const added = await addRes.json() as any;
    assert.equal(added.name, 'gpt-4o');
    assert.equal(added.maskedKey, 'sk-****-123');

    // 3. Create session with this modelId
    const ws = runtime.addWorkspace(dir);
    const sessionRes = await app.request('/api/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: ws.id,
        modelId: added.id
      })
    });
    assert.equal(sessionRes.status, 201);
    const session = await sessionRes.json() as any;
    assert.equal(session.modelId, added.id);
    assert.equal(session.config.values.model.name, 'gpt-4o');
    // Secret was redacted in snapshot
    assert.match(session.config.values.model.apiKey, /^credential:/);

    // 4. Delete model via API
    const delRes = await app.request(`/api/v1/models/${added.id}/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    assert.equal(delRes.status, 200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Multi-model API configuration saves enabled models and resolves composite model switching', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cheese-multi-models-'));
  try {
    const runtime = new Runtime(dir, undefined, { configDir: dir, modelDir: dir });
    const app = createApp(runtime);

    // 1. Add API configuration with multiple enabled models
    const addRes = await app.request('/api/v1/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        label: 'CPA Antigravity',
        provider: 'custom',
        name: 'claude-sonnet-4-6',
        models: ['claude-sonnet-4-6', 'gemini-2.5-pro', 'gemini-2.5-flash'],
        baseURL: 'https://proxy.antigravity.internal/v1',
        apiKey: 'sk-ant-multi-123456',
        isDefault: true
      })
    });
    assert.equal(addRes.status, 201);
    const config = await addRes.json() as any;
    assert.equal(config.name, 'claude-sonnet-4-6');
    assert.deepEqual(config.models, ['claude-sonnet-4-6', 'gemini-2.5-pro', 'gemini-2.5-flash']);

    // 2. Resolve model by composite identifier "configId:modelName"
    const resolvedSonnet = runtime.modelStore.resolveModel(`${config.id}:claude-sonnet-4-6`);
    assert.equal(resolvedSonnet?.name, 'claude-sonnet-4-6');
    assert.equal(resolvedSonnet?.baseURL, 'https://proxy.antigravity.internal/v1');

    const resolvedGemini = runtime.modelStore.resolveModel(`${config.id}:gemini-2.5-pro`);
    assert.equal(resolvedGemini?.name, 'gemini-2.5-pro');
    assert.equal(resolvedGemini?.apiKey, 'sk-ant-multi-123456');

    // 3. Create session with composite model identifier
    const ws = runtime.addWorkspace(dir);
    const sessionRes = await app.request('/api/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: ws.id,
        modelId: `${config.id}:gemini-2.5-pro`
      })
    });
    assert.equal(sessionRes.status, 201);
    const session = await sessionRes.json() as any;
    assert.equal(session.modelId, `${config.id}:gemini-2.5-pro`);
    assert.equal(session.config.values.model.name, 'gemini-2.5-pro');
    assert.equal(session.config.values.model.baseURL, 'https://proxy.antigravity.internal/v1');
    assert.match(session.config.values.model.apiKey, /^credential:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
