import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime, RuntimeError } from '../src/runtime/service.js';
import { createApp } from '../src/web/server.js';
import type { Execution } from '../src/runtime/service.js';

test('Session persists activeSkills, validates updates, and enforces 409 on running task', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cheese-skills-runtime-'));
  let blockPromise: Promise<void> | undefined;
  let releaseExecution: (() => void) | undefined;

  try {
    let capturedActiveSkills: string[] | undefined;
    const runtime = new Runtime(dir, async (exec: Execution) => {
      capturedActiveSkills = exec.activeSkills;
      if (blockPromise) {
        await blockPromise;
      }
      return [...exec.messages, { role: 'assistant', content: 'done' }];
    });

    const workspace = runtime.addWorkspace(dir);

    // 1. Create session with initial activeSkills
    const session = runtime.createSession(workspace.id, undefined, ['code-review']);
    assert.deepEqual(session.activeSkills, ['code-review']);

    // 2. Submit a run and verify activeSkills are forwarded to executor
    runtime.submit(session.id, 'test task', 'key-1');
    await runtime.idle();
    assert.deepEqual(capturedActiveSkills, ['code-review']);

    // 3. Update session skills successfully with deduplication
    const updated = runtime.updateSessionSkills(session.id, ['git-commit', 'code-review', 'git-commit', ' ']);
    assert.deepEqual(updated.activeSkills, ['git-commit', 'code-review']);
    assert.deepEqual(runtime.session(session.id).activeSkills, ['git-commit', 'code-review']);

    // 4. Verify persistence across Runtime instances
    const recovered = new Runtime(dir, async ({ messages }) => messages);
    assert.deepEqual(recovered.session(session.id).activeSkills, ['git-commit', 'code-review']);

    // 5. Test 409 concurrency protection when task is executing
    blockPromise = new Promise(resolve => { releaseExecution = resolve; });
    runtime.submit(session.id, 'long running task', 'key-2');

    // Attempting to update skills while running should throw 409
    assert.throws(
      () => runtime.updateSessionSkills(session.id, ['refactor']),
      (err: any) => err instanceof RuntimeError && err.status === 409
    );

    // Release the blocked task
    releaseExecution?.();
    await runtime.idle();

    // Now update should succeed
    const afterRun = runtime.updateSessionSkills(session.id, ['refactor']);
    assert.deepEqual(afterRun.activeSkills, ['refactor']);
  } finally {
    releaseExecution?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP API endpoints serve skills and update session skills correctly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cheese-skills-api-'));
  const wsDir = join(dir, 'workspace');
  const wsSkillsDir = join(wsDir, '.skills', 'test-skill');
  mkdirSync(wsSkillsDir, { recursive: true });
  writeFileSync(
    join(wsSkillsDir, 'SKILL.md'),
    `---
name: test-skill
description: "Test skill description"
---
# Test Skill SOP`
  );

  try {
    const runtime = new Runtime(dir, async ({ messages }) => messages);
    const workspace = runtime.addWorkspace(wsDir);
    const app = createApp(runtime);

    // 1. GET /api/v1/skills?workspaceId=...
    const getRes = await app.request(`/api/v1/skills?workspaceId=${workspace.id}`, {
      headers: { host: 'localhost:3210' }
    });
    assert.equal(getRes.status, 200);
    const getData = await getRes.json() as { skills: Array<{ name: string; description: string; source: string }> };
    assert.ok(Array.isArray(getData.skills));
    const found = getData.skills.find(s => s.name === 'test-skill');
    assert.ok(found);
    assert.equal(found.description, 'Test skill description');
    assert.equal(found.source, 'workspace');

    // 2. POST /api/v1/sessions with activeSkills
    const createRes = await app.request('/api/v1/sessions', {
      method: 'POST',
      headers: { host: 'localhost:3210', 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: workspace.id, activeSkills: ['test-skill'] })
    });
    assert.equal(createRes.status, 201);
    const sessionData = await createRes.json() as { id: string; activeSkills?: string[] };
    assert.deepEqual(sessionData.activeSkills, ['test-skill']);

    // 3. POST /api/v1/sessions/:id/skills
    const updateRes = await app.request(`/api/v1/sessions/${sessionData.id}/skills`, {
      method: 'POST',
      headers: { host: 'localhost:3210', 'content-type': 'application/json' },
      body: JSON.stringify({ skills: ['test-skill', 'new-skill'] })
    });
    assert.equal(updateRes.status, 200);
    const updatedData = await updateRes.json() as { id: string; activeSkills?: string[] };
    assert.deepEqual(updatedData.activeSkills, ['test-skill', 'new-skill']);

    // 4. Rejects malformed payload (not JSON object or missing skills array)
    const malformedRes = await app.request(`/api/v1/sessions/${sessionData.id}/skills`, {
      method: 'POST',
      headers: { host: 'localhost:3210', 'content-type': 'application/json' },
      body: JSON.stringify({ invalid: 123 })
    });
    assert.equal(malformedRes.status, 400);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
