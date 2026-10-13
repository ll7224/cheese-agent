import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledgeTestEnv } from './helpers/knowledge-fixture.js';
import { KnowledgeService } from '../src/knowledge/service.js';
import type { KnowledgeContext, SearchRequest } from '../src/knowledge/types.js';
import type { CaptureInput } from '../src/knowledge/capture.js';

test('P2-Scenario 5: TS/JS 代码结构索引与局部图谱合并与隔离', async (t) => {
  const env = createKnowledgeTestEnv(t);
  const store = env.store;
  const service = new KnowledgeService({ dataDir: env.tempDir, store });

  const p1Lib = store.createLibrary({
    id: 'project:ws-p1',
    name: 'Project P1 Lib',
    description: 'P1 Workspace Library',
    scope: 'project',
    workspaceId: 'ws-p1',
    role: 'project',
  });

  const p2Lib = store.createLibrary({
    id: 'project:ws-p2',
    name: 'Project P2 Lib',
    description: 'P2 Workspace Library',
    scope: 'project',
    workspaceId: 'ws-p2',
    role: 'project',
  });

  const ctxP1: KnowledgeContext = {
    workspaceId: 'ws-p1',
    workspacePath: env.tempDir,
    agentId: 'general',
    role: 'owner',
  };

  const ctxP2: KnowledgeContext = {
    workspaceId: 'ws-p2',
    workspacePath: env.tempDir,
    agentId: 'general',
    role: 'owner',
  };

  // 1. 导入代码文件
  const fileAContent = `import { helper } from './shared.ts';
export function calculate(): number {
  return helper() + 1;
}`;
  const fileBContent = `export function calculate(): number {
  return 100;
}`;
  const sharedContent = `export function helper(): number {
  return 42;
}`;
  const fileCContent = `import { helper } from './shared.ts';
export function runner(): number {
  return helper() * 2;
}`;

  await service.dispatch(ctxP1, {
    op: 'ingest',
    input: { content: fileAContent, name: 'fileA.ts', libraryId: p1Lib.id },
  });
  await service.dispatch(ctxP1, {
    op: 'ingest',
    input: { content: fileBContent, name: 'fileB.ts', libraryId: p1Lib.id },
  });
  await service.dispatch(ctxP1, {
    op: 'ingest',
    input: { content: sharedContent, name: 'shared.ts', libraryId: p1Lib.id },
  });
  await service.dispatch(ctxP1, {
    op: 'ingest',
    input: { content: fileCContent, name: 'fileC.ts', libraryId: p1Lib.id },
  });

  // 2. 两个文件同名函数不合并
  const calcEntities = store.db.prepare(`
    SELECT * FROM entities WHERE name = 'calculate' AND workspace_id = 'ws-p1'
  `).all() as any[];
  assert.equal(calcEntities.length, 2, '两个文件的同名函数不合并');
  assert.notEqual(calcEntities[0].id, calcEntities[1].id, '不同文件的实体 ID 必须区分');

  // 3. 边存在且带有版本证据
  const importEdges = store.db.prepare(`
    SELECT * FROM edges WHERE source_id LIKE '%fileA.ts%' AND kind = 'imports'
  `).all() as any[];
  assert.ok(importEdges.length > 0);
  const edgeEvidences = store.db.prepare(`
    SELECT * FROM edge_evidence WHERE edge_id = ?
  `).all(importEdges[0].id) as any[];
  assert.ok(edgeEvidences.length > 0);
  assert.equal(edgeEvidences[0].start_line, 1);

  // 插入候选语义边
  const candEdgeId = 'cand-edge-semantic-1';
  store.db.prepare(`
    INSERT INTO edges (id, source_id, target_id, kind, status, library_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(candEdgeId, calcEntities[0].id, calcEntities[1].id, 'explains', 'candidate', p1Lib.id);

  // 4. 修改依赖后旧边退出，共享目标与候选边保留
  const updatedFileAContent = `import { other } from './other.ts';
export function calculate(): number {
  return other();
}`;
  await service.dispatch(ctxP1, {
    op: 'ingest',
    input: { content: updatedFileAContent, name: 'fileA.ts', libraryId: p1Lib.id },
  });

  const oldImportEdge = store.db.prepare(`
    SELECT * FROM edges WHERE source_id LIKE '%fileA.ts%' AND target_id LIKE '%shared.ts%'
  `).all();
  assert.equal(oldImportEdge.length, 0, '旧边必须退出');

  const candRow = store.db.prepare(`SELECT * FROM edges WHERE id = ?`).get(candEdgeId) as any;
  assert.ok(candRow);
  assert.equal(candRow.status, 'candidate', '候选语义边必须保留 candidate 状态');

  // 5. 跨项目隔离
  const p2SecretContent = `export function secretAlgo(): number { return 12345; }`;
  await service.dispatch(ctxP2, {
    op: 'ingest',
    input: { content: p2SecretContent, name: 'secret.ts', libraryId: p2Lib.id },
  });

  const p1Overview = service.graph(ctxP1);
  assert.ok(!p1Overview.nodes.some((n) => n.name === 'secretAlgo'));
});

test('P2-Scenario 6: 自动沉淀、同 run 去重、显式决定与可信执行记录', async (t) => {
  const env = createKnowledgeTestEnv(t);
  const store = env.store;
  const service = new KnowledgeService({ dataDir: env.tempDir, store });

  const ctx: KnowledgeContext = {
    workspaceId: 'ws-capture',
    workspacePath: env.tempDir,
    agentId: 'general',
    role: 'owner',
  };
  service.attachWorkspace(ctx);

  const runId1 = 'run-test-001';
  const input1: CaptureInput = {
    runId: runId1,
    sessionId: 'session-001',
    workspaceId: 'ws-capture',
    userInput: '我们决定统一采用 TypeScript 严格模式进行类型检查',
    messages: [
      { role: 'user', content: '我们决定统一采用 TypeScript 严格模式进行类型检查' },
      {
        role: 'assistant',
        content: `经测试代码完全正确，我已经全面验证了该架构是绝对可靠的。\n建议：在 CI 中加入 pnpm typecheck 步骤以阻断错误。`,
      },
    ],
    events: [
      {
        id: 'evt-1',
        runId: runId1,
        sessionId: 'session-001',
        workspaceId: 'ws-capture',
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: 'execution-evidence',
        executionId: 'exec-success-01',
        command: 'pnpm test',
        cwd: env.tempDir,
        exitCode: 0,
        timedOut: false,
        stdout: 'Tests passed: 42',
        stderr: '',
      },
      {
        id: 'evt-2',
        runId: runId1,
        sessionId: 'session-001',
        workspaceId: 'ws-capture',
        sequence: 2,
        timestamp: new Date().toISOString(),
        type: 'execution-evidence',
        executionId: 'exec-timeout-02',
        command: 'sleep 100',
        cwd: env.tempDir,
        exitCode: null,
        timedOut: true,
        stdout: '',
        stderr: 'Process killed due to timeout',
      },
      {
        id: 'evt-3',
        runId: runId1,
        sessionId: 'session-001',
        workspaceId: 'ws-capture',
        sequence: 3,
        timestamp: new Date().toISOString(),
        type: 'execution-evidence',
        executionId: 'exec-failed-03',
        command: 'exit 1',
        cwd: env.tempDir,
        exitCode: 1,
        timedOut: false,
        stdout: '',
        stderr: 'Command failed with exit code 1',
      },
    ],
    environment: {
      cwd: env.tempDir,
      runtimeVersion: '1.0.0',
    },
  };

  service.enqueueCapture(ctx, input1);
  await service.captureQueue.waitForRun(runId1);

  // 同 run 去重
  service.enqueueCapture(ctx, input1);
  const jobRows = store.db.prepare('SELECT * FROM capture_jobs WHERE run_id = ?').all(runId1);
  assert.equal(jobRows.length, 1);

  const items = service.listItems(ctx);
  const decisionItem = items.find((i) => i.kind === 'decision');
  assert.ok(decisionItem);
  assert.equal(decisionItem.status, 'effective');

  const successObs = items.find((i) => i.evidenceIds.includes('exec-success-01'));
  assert.ok(successObs);
  assert.equal(successObs.status, 'effective');
  assert.equal(successObs.applicability, env.tempDir);

  const timeoutObs = items.find((i) => i.evidenceIds.includes('exec-timeout-02'));
  assert.equal(timeoutObs, undefined);

  const failedObs = items.find((i) => i.evidenceIds.includes('exec-failed-03'));
  assert.equal(failedObs, undefined);

  const selfClaimObs = items.find((i) => i.text.includes('经测试代码完全正确'));
  assert.equal(selfClaimObs, undefined);

  const candidateExp = items.find((i) => i.text.includes('在 CI 中加入 pnpm typecheck'));
  assert.ok(candidateExp);
  assert.equal(candidateExp.status, 'candidate');
});

test('P2-Task 7: 沉淀条目纠错、状态过滤与 fact/experience 模式隔离', async (t) => {
  const env = createKnowledgeTestEnv(t);
  const store = env.store;
  const service = new KnowledgeService({ dataDir: env.tempDir, store });

  const ctx: KnowledgeContext = {
    workspaceId: 'ws-isolation',
    workspacePath: env.tempDir,
    agentId: 'general',
    role: 'owner',
  };
  service.attachWorkspace(ctx);

  const targetLibId = `project:ws-isolation`;

  // 1. 创建一条 effective 规则与一条 candidate 经验
  const effItem = store.createKnowledgeItem({
    id: 'item-eff-1',
    kind: 'decision',
    status: 'effective',
    text: '生产环境强制启用 TLS 1.3 密码套件',
    libraryId: targetLibId,
    evidenceIds: ['ev-01'],
    applicability: 'project',
  });

  const candItem = store.createKnowledgeItem({
    id: 'item-cand-1',
    kind: 'experience',
    status: 'candidate',
    text: '候选经验：尝试使用 Redis 缓存会话数据以提升并发',
    libraryId: targetLibId,
    evidenceIds: ['ev-02'],
    applicability: 'project',
  });

  // 在向量/FTS 中建立对应的索引条目
  store.vectorStore.upsertIndexedChunks([
    {
      id: `chunk-eff-1`,
      text: effItem.text,
      source: 'decision',
      chunkIndex: 0,
      collectionId: `${targetLibId}:effective`,
    },
    {
      id: `chunk-cand-1`,
      text: candItem.text,
      source: 'experience',
      chunkIndex: 0,
      collectionId: `${targetLibId}:candidate`,
    },
  ]);

  // 2. 验证：fact 模式只检索 effective 分区，绝不返回 candidate
  const factSearch: SearchRequest = {
    query: 'TLS',
    mode: 'fact',
    topK: 5,
    libraryIds: [targetLibId],
  };
  const factResult = await service.search(ctx, factSearch);
  assert.ok(factResult.hits.some((h) => h.text.includes('TLS 1.3')));

  const factSearchCand: SearchRequest = {
    query: 'Redis 缓存',
    mode: 'fact',
    topK: 5,
    libraryIds: [targetLibId],
  };
  const factCandResult = await service.search(ctx, factSearchCand);
  assert.equal(
    factCandResult.hits.length,
    0,
    'fact 模式绝对不能召回 candidate 状态的经验'
  );

  // 3. 验证：experience 模式同时检索 effective 和 candidate 分区
  const expSearch: SearchRequest = {
    query: 'Redis 缓存',
    mode: 'experience',
    topK: 5,
    libraryIds: [targetLibId],
  };
  const expResult = await service.search(ctx, expSearch);
  assert.ok(expResult.hits.some((h) => h.text.includes('Redis 缓存')));

  // 4. 验证：纠错功能 (correctItem)
  // 将 effItem 纠正为新规范
  const corrected = service.correctItem(
    ctx,
    effItem.id,
    '生产环境已全面升级为 TLS 1.3 并禁用旧套件'
  );
  assert.equal(corrected.status, 'effective');
  assert.equal(corrected.supersedes, effItem.id);

  // 检查旧条目状态变为 invalidated
  const oldItem = store.getKnowledgeItem(effItem.id);
  assert.equal(oldItem?.status, 'invalidated', '被纠正的旧条目必须变为 invalidated');

  // 5. 验证：invalidated 状态绝对退出检索
  const searchAfterCorrection = await service.search(ctx, {
    query: '生产环境',
    mode: 'experience',
    topK: 5,
    libraryIds: [targetLibId],
  });
  // 必须能检索到新条目
  assert.ok(
    searchAfterCorrection.hits.some((h) => h.text.includes('已全面升级为 TLS 1.3')),
    '新纠正的条目必须能被检索到'
  );

  // 6. 验证：条目状态筛选列表 (listItems)
  const allItems = service.listItems(ctx);
  assert.ok(allItems.length >= 3);

  const effectiveOnly = service.listItems(ctx, 'effective');
  assert.ok(effectiveOnly.every((i) => i.status === 'effective'));

  const candidateOnly = service.listItems(ctx, 'candidate');
  assert.ok(candidateOnly.every((i) => i.status === 'candidate'));

  const invalidatedOnly = service.listItems(ctx, 'invalidated');
  assert.ok(invalidatedOnly.every((i) => i.status === 'invalidated'));
  assert.ok(invalidatedOnly.some((i) => i.id === effItem.id));
});
