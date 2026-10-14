import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { createKnowledgeTestEnv } from './helpers/knowledge-fixture.js';
import { KnowledgeService } from '../src/knowledge/service.js';
import { chunkWithSpans } from '../src/knowledge/chunks.js';
import { bindLibraryWorkspaces, getLibraryWorkspaceIds } from '../src/knowledge/libraries.js';
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

test('P3-Scenario 10: 从工程技术文档提炼沉淀知识 (Bootstrap from Docs)', async (t) => {
  const env = createKnowledgeTestEnv(t);
  const store = env.store;
  const service = new KnowledgeService({ dataDir: env.tempDir, store });

  const ctx: KnowledgeContext = {
    workspaceId: 'ws-bootstrap',
    workspacePath: env.tempDir,
    agentId: 'general',
    role: 'owner',
  };
  service.attachWorkspace(ctx);

  const libId = `project:ws-bootstrap`;

  // 1. 先建立一个代码文件，解析产生 AST 实体 (如 handleLogin)
  const codeContent = `
export function handleLogin(username: string): boolean {
  return username.length > 0;
}
`;
  await service.dispatch(ctx, {
    op: 'ingest',
    input: { content: codeContent, name: 'src/auth.ts', libraryId: libId },
  });

  const ent = store.listEntities({ workspaceId: 'ws-bootstrap' }).find((e) => e.name === 'handleLogin');
  assert.ok(ent, '代码实体 handleLogin 必须被索引');

  // 2. 创建一个包含架构决策 ADR 与规范的 Markdown 工程文档
  const docMarkdown = `# 认证系统架构规范与 ADR

## 架构决策 (Decision)
- **ADR-001**: 系统中所有的用户认证调用必须由 handleLogin 统一接入并签发 JWT
- 生产环境统一使用 PostgreSQL 作为持久化存储

## 规范与约束 (Constraints)
- 单次认证请求超时时限必须在 2000ms 以内
- 严禁在客户端直接保存明文密钥

## 实践经验与最佳实践 (Practices)
- 建议优先使用连接池复用数据库会话
`;

  const ingestRes = await service.dispatch(ctx, {
    op: 'ingest',
    input: { content: docMarkdown, name: 'docs/auth-adr.md', libraryId: libId },
  });
  const docId = ingestRes.documentId;
  assert.ok(docId, '文档导入成功');

  // 3. 执行单文档提炼预览 previewExtractDocument
  const drafts = await service.previewExtractDocument(ctx, docId);
  assert.ok(drafts.length >= 3, `应该提取出至少 3 条知识草稿，实际提取到 ${drafts.length}`);

  // 验证提取出来的草稿属性
  const loginDraft = drafts.find((d) => d.text.includes('handleLogin'));
  assert.ok(loginDraft, '必须提炼出包含 handleLogin 的条目');
  assert.equal(loginDraft.kind, 'decision');
  assert.equal(loginDraft.status, 'candidate', '文档提取的知识默认设为待验证 candidate 状态');
  assert.ok(loginDraft.evidenceChunkId, '必须保留底层切片 ID');
  assert.ok(loginDraft.startLine > 0, '必须包含行号');
  assert.ok(loginDraft.matchedEntityIds?.includes(ent.id), '必须自动关联 handleLogin 实体');
  assert.ok(loginDraft.matchedEntityNames?.includes('handleLogin'));

  // 4. 执行全量文档提炼预览 previewExtractAllDocs
  const allDocDrafts = await service.previewExtractAllDocs(ctx, libId);
  assert.ok(allDocDrafts.length >= 1);
  const foundInBatch = allDocDrafts.find((d) => d.documentId === docId);
  assert.ok(foundInBatch && foundInBatch.items.length >= 3);

  // 5. 提交入库 commitExtractedDocItems
  // 选择将 loginDraft 提升为 effective，将另一条作为 candidate
  const draftToCommit1 = { ...loginDraft, status: 'effective' as const };
  const practiceDraft = drafts.find((d) => d.kind === 'experience') || drafts[1];
  const draftToCommit2 = { ...practiceDraft, status: 'candidate' as const };

  const initialGen = store.getGeneration();
  const committedItems = service.commitExtractedDocItems(ctx, docId, [draftToCommit1, draftToCommit2]);
  assert.equal(committedItems.length, 2);
  assert.ok(store.getGeneration() > initialGen, '入库后 generation 版本号必须递增');

  // 验证图谱关联边：loginDraft 关联了 handleLogin，检查 edges 表
  const edges = store.db.prepare('SELECT * FROM edges WHERE source_id = ?').all(committedItems[0].id) as any[];
  assert.ok(edges.length >= 1, '提炼知识必须自动生成指向关联代码实体的图谱边');
  assert.equal(edges[0].target_id, ent.id);
  assert.ok(['explains', 'constrains'].includes(edges[0].kind));

  // 6. 验证防御策略与检索表现
  // (a) fact 模式：仅召回 status=effective 的条目，绝对不召回 status=candidate 的条目
  const factSearch = await service.search(ctx, {
    query: 'handleLogin',
    mode: 'fact',
    topK: 5,
    libraryIds: [libId],
  });
  assert.ok(
    factSearch.hits.some((h) => h.citation.documentId === committedItems[0].id),
    'fact 模式必须能检索到提升为 effective 的提炼条目'
  );

  const factSearchCand = await service.search(ctx, {
    query: draftToCommit2.text.slice(0, 8),
    mode: 'fact',
    topK: 5,
    libraryIds: [libId],
  });
  assert.equal(
    factSearchCand.hits.filter((h) => h.citation.documentId === committedItems[1].id).length,
    0,
    'fact 模式绝不能召回仍为 candidate 状态的知识条目'
  );

  // (b) experience 模式：同时召回 candidate 状态与 effective 状态的条目
  const expSearch = await service.search(ctx, {
    query: draftToCommit2.text.slice(0, 8),
    mode: 'experience',
    topK: 5,
    libraryIds: [libId],
  });
  assert.ok(
    expSearch.hits.some((h) => h.citation.documentId === committedItems[1].id),
    'experience 模式必须能召回 candidate 知识条目'
  );
});

test('P3-Scenario 11: 公共领域知识库文档管理、提炼与沉淀权限测试 (Manageable Public Domain Library Extraction)', async (t) => {
  const env = createKnowledgeTestEnv(t);
  const store = env.store;
  const service = new KnowledgeService({ dataDir: env.tempDir, store });

  const ctx: KnowledgeContext = {
    workspaceId: 'ws-domain-test',
    workspacePath: env.tempDir,
    agentId: 'general',
    role: 'owner',
  };
  service.attachWorkspace(ctx);

  // 1. 创建一个公共领域库 (scope=public, role=domain)
  const domainLib = store.createLibrary({
    id: 'pub-test-domain-lib',
    name: '公共领域知识库',
    description: '用于测试领域知识库文档提取',
    scope: 'public',
    role: 'domain',
    workspaceId: null,
    enabled: true,
  });

  // 2. 向该领域库创建来源并发布一份 ADR 规范文档
  const docMarkdown = `# 领域知识库规范
## 架构决策 (Decision)
- **ADR-101**: 生产环境数据库连接池大小必须统一设定为 20
- **ADR-102**: 必须统一使用 AES-256 加密存储敏感字段
`;

  const source = store.createSource({
    id: 'src-domain-docs',
    libraryId: domainLib.id,
    kind: 'managed',
    locator: 'docs/domain-guidelines.md',
    enabled: true,
  });

  const rawChunks = chunkWithSpans(docMarkdown);
  const hash = crypto.createHash('sha256').update(docMarkdown).digest('hex');
  const pubRes = store.publishRevision({
    sourceId: source.id,
    sourceKey: 'docs/domain-guidelines.md',
    content: docMarkdown,
    hash,
    expectedPreviousRevisionId: null,
    chunks: rawChunks.map((c) => ({
      text: c.text,
      span: c.span,
      evidenceKind: 'document',
    })),
  });
  const docId = pubRes.documentId;
  assert.ok(docId, '公共领域库文档发布成功');

  // 3. 验证：预览提取不会报 Access denied
  const drafts = await service.previewExtractDocument(ctx, docId);
  assert.ok(drafts.length >= 2, `应该成功提取至少 2 条草稿，实际提取到 ${drafts.length}`);
  assert.ok(drafts.some((d) => d.text.includes('AES-256')));

  // 4. 验证：批量预览也不会报 Access denied
  const batchDrafts = await service.previewExtractAllDocs(ctx, domainLib.id);
  assert.ok(batchDrafts.length >= 1);

  // 5. 验证：确认入库不会报 Access denied
  const committed = service.commitExtractedDocItems(ctx, docId, [
    { ...drafts[0], status: 'effective' },
  ]);
  assert.equal(committed.length, 1);
  assert.equal(committed[0].libraryId, domainLib.id);

  // 6. 验证：listItems 在管理端能查出该公共领域库的条目
  const items = service.listItems(ctx);
  assert.ok(items.some((i) => i.id === committed[0].id), '管理端应能列出公共领域库中的沉淀条目');
});

test('P3-Scenario 12: 知识库多工作区自主绑定与跨工作区隔离权限测试 (Multi-Workspace Binding & Cross-Workspace Isolation)', async (t) => {
  const env = createKnowledgeTestEnv(t);
  const store = env.store;
  const service = new KnowledgeService({ dataDir: env.tempDir, store });

  const ctxA: KnowledgeContext = {
    workspaceId: 'ws-alpha',
    workspacePath: path.join(env.tempDir, 'alpha'),
    agentId: 'general',
    role: 'owner',
  };
  const ctxB: KnowledgeContext = {
    workspaceId: 'ws-beta',
    workspacePath: path.join(env.tempDir, 'beta'),
    agentId: 'general',
    role: 'owner',
  };
  const ctxC: KnowledgeContext = {
    workspaceId: 'ws-gamma',
    workspacePath: path.join(env.tempDir, 'gamma'),
    agentId: 'general',
    role: 'owner',
  };

  service.attachWorkspace(ctxA);
  service.attachWorkspace(ctxB);
  service.attachWorkspace(ctxC);

  // 1. 创建一个多工作区绑定的项目库 (同时绑定 ws-alpha 和 ws-beta)
  const sharedLib = store.createLibrary({
    id: 'project:shared-lib:001',
    name: '跨端微服务研发知识库',
    description: '供 Alpha 和 Beta 共享的项目专属库',
    scope: 'project',
    workspaceId: 'ws-alpha',
    workspaceIds: ['ws-alpha', 'ws-beta'],
    role: 'project',
  });

  // 验证绑定持久化
  const boundWs = getLibraryWorkspaceIds(store.db, sharedLib.id);
  assert.ok(boundWs.includes('ws-alpha'));
  assert.ok(boundWs.includes('ws-beta'));
  assert.ok(!boundWs.includes('ws-gamma'));

  // 2. 在该库中写入一篇架构文档
  const docMarkdown = `# 跨工作区服务规范
## 架构规范与约束 (Rules)
- **MW-201**: 微服务网关全局超时时间必须统一设定为 3000ms
- **MW-202**: 消息队列消费幂等 Key 必须统一使用 requestId 与 bizCode 的哈希
`;
  const source = store.createSource({
    id: 'src-shared-spec',
    libraryId: sharedLib.id,
    kind: 'managed',
    locator: 'docs/mw-specs.md',
    enabled: true,
  });

  const rawChunks = chunkWithSpans(docMarkdown);
  const hash = crypto.createHash('sha256').update(docMarkdown).digest('hex');
  const pubRes = store.publishRevision({
    sourceId: source.id,
    sourceKey: 'docs/mw-specs.md',
    content: docMarkdown,
    hash,
    expectedPreviousRevisionId: null,
    chunks: rawChunks.map((c) => ({
      text: c.text,
      span: c.span,
      evidenceKind: 'document',
    })),
  });
  const docId = pubRes.documentId;

  // 3. 验证管理权限隔离 (getManageableLibraryIds)
  const manageableA = service.getManageableLibraryIds(ctxA);
  const manageableB = service.getManageableLibraryIds(ctxB);
  const manageableC = service.getManageableLibraryIds(ctxC);

  assert.ok(manageableA.includes(sharedLib.id), 'ws-alpha 拥有 sharedLib 管理权限');
  assert.ok(manageableB.includes(sharedLib.id), 'ws-beta 拥有 sharedLib 管理权限');
  assert.ok(!manageableC.includes(sharedLib.id), 'ws-gamma 未绑定，绝不能拥有 sharedLib 管理权限');

  // 4. 验证提炼操作权限隔离
  // ws-beta 应该能提取
  const draftsB = await service.previewExtractDocument(ctxB, docId);
  assert.ok(draftsB.length >= 2, 'ws-beta 可以成功提炼该共享库文档');

  // ws-gamma 提炼必须抛出 Access denied 异常
  await assert.rejects(
    async () => {
      await service.previewExtractDocument(ctxC, docId);
    },
    /Access denied to document/,
    '未绑定的 ws-gamma 提炼文档必须被拒绝'
  );

  // 5. 验证执行检索 (search) 隔离
  const searchA = await service.search(ctxA, {
    query: '超时时间必须统一设定为 3000ms',
    mode: 'fact',
    topK: 5,
  });
  assert.ok(searchA.hits.some((h) => h.text.includes('3000ms')), 'ws-alpha 能够检索到共享库知识');

  const searchB = await service.search(ctxB, {
    query: '超时时间必须统一设定为 3000ms',
    mode: 'fact',
    topK: 5,
  });
  assert.ok(searchB.hits.some((h) => h.text.includes('3000ms')), 'ws-beta 能够检索到共享库知识');

  const searchC = await service.search(ctxC, {
    query: '超时时间必须统一设定为 3000ms',
    mode: 'fact',
    topK: 5,
  });
  assert.ok(!searchC.hits.some((h) => h.text.includes('3000ms')), 'ws-gamma 未绑定，不可检索到共享库知识');

  // 6. 动态调整绑定：将 sharedLib 改为绑定至 ws-beta 和 ws-gamma (移除 ws-alpha)
  bindLibraryWorkspaces(store.db, sharedLib.id, ['ws-beta', 'ws-gamma']);

  // 验证动态调整后各工作区的权限实时变更
  const updatedManageableA = service.getManageableLibraryIds(ctxA);
  const updatedManageableC = service.getManageableLibraryIds(ctxC);

  assert.ok(!updatedManageableA.includes(sharedLib.id), '解除绑定后，ws-alpha 立即失去管理权限');
  assert.ok(updatedManageableC.includes(sharedLib.id), '加入绑定后，ws-gamma 立即获得管理权限');

  // 验证 ws-gamma 现在可以成功提炼
  const draftsC = await service.previewExtractDocument(ctxC, docId);
  assert.ok(draftsC.length >= 2, 'ws-gamma 获得绑定后可以正常提炼');

  // 验证 ws-alpha 现在被拒绝
  await assert.rejects(
    async () => {
      await service.previewExtractDocument(ctxA, docId);
    },
    /Access denied to document/,
    '被解绑的 ws-alpha 提炼文档应被拒绝'
  );
});

