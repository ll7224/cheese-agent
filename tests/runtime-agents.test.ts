import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime, RuntimeError } from '../src/runtime/service.js';
import { createApp } from '../src/web/server.js';
import type { Execution } from '../src/runtime/service.js';

test('Session persists agentId, binds domain agent, and enforces 409 on running task', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cheese-agents-runtime-'));
  const agentsDir = join(dir, '.agents');
  mkdirSync(agentsDir, { recursive: true });

  // Create a local domain agent: "code-auditor"
  const auditorDir = join(agentsDir, 'code-auditor');
  mkdirSync(auditorDir);
  writeFileSync(
    join(auditorDir, 'agent.json'),
    JSON.stringify({
      id: 'code-auditor',
      name: '代码审计专家',
      tools: ['file_read'],
      skills: ['code-review'],
    })
  );

  let blockPromise: Promise<void> | undefined;
  let releaseExecution: (() => void) | undefined;

  try {
    let capturedAgentId: string | undefined;
    const runtime = new Runtime(dir, async (exec: Execution) => {
      capturedAgentId = exec.agentId;
      if (blockPromise) {
        await blockPromise;
      }
      return [...exec.messages, { role: 'assistant', content: 'done' }];
    });

    const workspace = runtime.addWorkspace(dir);

    // 1. Default session binds to 'general'
    const defaultSession = runtime.createSession(workspace.id);
    assert.equal(defaultSession.agentId, 'general');

    // 2. Create session with explicit agentId
    const auditorSession = runtime.createSession(workspace.id, undefined, [], 'code-auditor');
    assert.equal(auditorSession.agentId, 'code-auditor');
    // Default skills from agent should be inherited if not provided
    assert.deepEqual(auditorSession.activeSkills, ['code-review']);

    // 3. Submit a run and verify agentId is forwarded to executor
    runtime.submit(auditorSession.id, 'check code', 'key-1');
    await runtime.idle();
    assert.equal(capturedAgentId, 'code-auditor');

    // 4. Update session agent
    const switched = runtime.updateSessionAgent(auditorSession.id, 'general');
    assert.equal(switched.agentId, 'general');
    assert.equal(runtime.session(auditorSession.id).agentId, 'general');

    // 5. Verify persistence across Runtime instances
    const recovered = new Runtime(dir, async ({ messages }) => messages);
    assert.equal(recovered.session(auditorSession.id).agentId, 'general');
    assert.equal(recovered.session(defaultSession.id).agentId, 'general');

    // 6. Test 409 concurrency protection when task is executing
    blockPromise = new Promise(resolve => { releaseExecution = resolve; });
    runtime.submit(auditorSession.id, 'long running task', 'key-2');

    assert.throws(
      () => runtime.updateSessionAgent(auditorSession.id, 'code-auditor'),
      (err: any) => err instanceof RuntimeError && err.status === 409
    );

    releaseExecution?.();
    await runtime.idle();

    // Now update should succeed
    const afterRun = runtime.updateSessionAgent(auditorSession.id, 'code-auditor');
    assert.equal(afterRun.agentId, 'code-auditor');
  } finally {
    releaseExecution?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP API endpoints serve agents and update session agent correctly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cheese-agents-api-'));
  const wsDir = join(dir, 'workspace');
  const wsAgentsDir = join(wsDir, '.agents');
  mkdirSync(wsAgentsDir, { recursive: true });

  const techAgentDir = join(wsAgentsDir, 'tech-writer');
  mkdirSync(techAgentDir);
  writeFileSync(
    join(techAgentDir, 'agent.json'),
    JSON.stringify({
      id: 'tech-writer',
      name: '技术文档专家',
      description: '专注撰写高质量技术文档',
      avatar: '✍️',
      tools: ['file_write'],
    })
  );

  try {
    const runtime = new Runtime(dir, async ({ messages }) => messages);
    const workspace = runtime.addWorkspace(wsDir);
    const app = createApp(runtime);

    // 1. GET /api/v1/agents
    const agentsRes = await app.request(`/api/v1/agents?workspaceId=${workspace.id}`);
    assert.equal(agentsRes.status, 200);
    const agentsData = await agentsRes.json();
    assert.ok(Array.isArray(agentsData.agents));
    assert.ok(agentsData.agents.some((a: any) => a.id === 'general'));
    assert.ok(agentsData.agents.some((a: any) => a.id === 'tech-writer'));

    // 2. POST /api/v1/sessions with agentId
    const createRes = await app.request('/api/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId: workspace.id,
        agentId: 'tech-writer',
      }),
    });
    assert.equal(createRes.status, 201);
    const sessionData = await createRes.json();
    assert.equal(sessionData.agentId, 'tech-writer');

    // 3. POST /api/v1/sessions/:id/agent to switch
    const switchRes = await app.request(`/api/v1/sessions/${sessionData.id}/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'general' }),
    });
    assert.equal(switchRes.status, 200);
    const switchedData = await switchRes.json();
    assert.equal(switchedData.agentId, 'general');

    // 4. POST /api/v1/sessions/:id/agent with invalid agentId returns 404
    const badRes = await app.request(`/api/v1/sessions/${sessionData.id}/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'unknown-agent' }),
    });
    assert.equal(badRes.status, 404);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
