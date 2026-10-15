import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { createKnowledgeTestEnv } from './helpers/knowledge-fixture.js';
import { KnowledgeService } from '../src/knowledge/service.js';
import { chunkWithSpans } from '../src/knowledge/chunks.js';
import { bindLibraryWorkspaces, getLibraryWorkspaceIds } from '../src/knowledge/libraries.js';
import { createJitGuardrailHook } from '../src/knowledge/jit-guardrails.js';
import { createKnowledgeRpcDispatcher } from '../src/runtime/knowledge-rpc.js';
import { createKnowledgeTools } from '../src/tools/knowledge-tools.js';
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

test('P3-Scenario 13: 知识库彻底删除与级联清理、已删除墓碑隔离与防重复创建测试 (Library Deletion & Cascade Cleanup)', async (t) => {
  const env = createKnowledgeTestEnv(t);
  const store = env.store;
  const service = new KnowledgeService({
    dataDir: env.tempDir,
    store,
  });

  const ctx: KnowledgeContext = {
    workspaceId: 'ws-del',
    workspacePath: env.tempDir,
    agentId: 'general',
    role: 'owner',
  };

  // 1. 接入工作区，生成默认库
  service.attachWorkspace(ctx);
  const projectLibId = 'project:ws-del';
  assert.ok(store.getLibrary(projectLibId), '默认项目库已创建');
  assert.ok(store.getLibrary('public-basic'), '默认公共基础库已创建');

  // 2. 在 projectLib 中创建来源、文档、版本和分块
  const source = store.createSource({
    id: 'src-del-1',
    libraryId: projectLibId,
    kind: 'local',
    locator: 'docs/test-delete.md',
    enabled: true,
  });

  const rev = store.publishRevision({
    sourceId: source.id,
    sourceKey: 'docs/test-delete.md',
    content: '测试待删除知识库的内容，必须包含有效分块以验证清理。',
    hash: 'hash-del-1',
    expectedPreviousRevisionId: null,
    chunks: [
      {
        text: '测试待删除知识库的内容，必须包含有效分块以验证清理。',
        span: { startOffset: 0, endOffset: 27, startLine: 1, endLine: 1 },
      },
    ],
  });

  // 创建一条沉淀知识条目
  store.createKnowledgeItem({
    id: 'item-del-1',
    kind: 'rule',
    status: 'effective',
    text: '待删除库中的规则沉淀',
    libraryId: projectLibId,
    evidenceIds: [],
  });

  // 验证数据已写入
  assert.ok(store.getSource('src-del-1'));
  assert.ok(store.getDocumentById(rev.documentId));
  assert.ok(store.getKnowledgeItem('item-del-1'));

  // 3. 执行删除知识库
  const deleteResult = store.deleteLibrary(projectLibId);
  assert.equal(deleteResult, true, 'deleteLibrary 应该返回 true');

  // 4. 验证级联清理完成
  assert.equal(store.getLibrary(projectLibId), null, '知识库已被删除');
  assert.equal(store.getSource('src-del-1'), null, '来源已被级联删除');
  assert.equal(store.getDocumentById(rev.documentId), null, '文档已被级联删除');
  assert.equal(store.listRevisions(rev.documentId).length, 0, '版本已被级联删除');
  assert.equal(store.getKnowledgeItem('item-del-1'), null, '沉淀条目已被级联删除');
  assert.equal(store.isLibraryDeleted(projectLibId), true, '知识库已被记录在墓碑表中');

  // 5. 验证 attachWorkspace 不会复活已删除的项目库
  service.attachWorkspace(ctx);
  assert.equal(store.getLibrary(projectLibId), null, 'attachWorkspace 不得重新创建已删除的项目库');

  // 6. 测试删除 public-basic 库并验证防复活
  const deletePublicResult = store.deleteLibrary('public-basic');
  assert.equal(deletePublicResult, true, 'deleteLibrary public-basic 成功');
  assert.equal(store.getLibrary('public-basic'), null, 'public-basic 已被删除');
  assert.equal(store.isLibraryDeleted('public-basic'), true, 'public-basic 处于墓碑状态');

  service.attachWorkspace(ctx);
  assert.equal(store.getLibrary('public-basic'), null, 'attachWorkspace 不得重新创建已删除的 public-basic');

  // 7. 测试显式创建同名知识库会清除墓碑
  store.createLibrary({
    id: projectLibId,
    name: 'Recreated Project Lib',
    description: '重新显式创建的库',
    scope: 'project',
    workspaceId: 'ws-del',
    role: 'project',
  });
  assert.equal(store.isLibraryDeleted(projectLibId), false, '显式重新创建后清除墓碑');
  assert.ok(store.getLibrary(projectLibId), '显式重新创建成功');
});

test('P3-Scenario 14: 列表分页支持与统计总数测试 (Pagination and Total Counts)', async (t) => {
  const env = createKnowledgeTestEnv(t);
  const store = env.store;
  const service = new KnowledgeService({
    dataDir: env.tempDir,
    store,
  });

  const ctx: KnowledgeContext = {
    workspaceId: 'ws-page',
    workspacePath: env.tempDir,
    agentId: 'general',
    role: 'owner',
  };
  service.attachWorkspace(ctx);

  const libId = `project:ws-page`;

  // 1. 创建测试文档源并写入 5 篇文档
  const src = store.createSource({
    id: 'src-page-test',
    libraryId: libId,
    kind: 'local',
    locator: 'docs/test',
    enabled: true,
    syncStatus: 'ready',
  });

  for (let i = 1; i <= 5; i++) {
    store.publishRevision({
      sourceId: src.id,
      sourceKey: `docs/doc-${i}.md`,
      content: `Content of doc ${i}`,
      hash: `hash-page-${i}`,
      expectedPreviousRevisionId: null,
      chunks: [],
      fileSize: 100,
    });
  }

  // 2. 验证文档总数与分页查询
  const totalDocs = store.countDocuments({ libraryId: libId });
  assert.equal(totalDocs, 5, '文档总数统计应为 5');

  const page1Docs = store.listDocumentsPaged({ libraryId: libId, limit: 2, offset: 0 });
  assert.equal(page1Docs.length, 2, '第 1 页应返回 2 篇文档');

  const page2Docs = store.listDocumentsPaged({ libraryId: libId, limit: 2, offset: 2 });
  assert.equal(page2Docs.length, 2, '第 2 页应返回 2 篇文档');

  const page3Docs = store.listDocumentsPaged({ libraryId: libId, limit: 2, offset: 4 });
  assert.equal(page3Docs.length, 1, '第 3 页应返回 1 篇文档');

  const overflowDocs = store.listDocumentsPaged({ libraryId: libId, limit: 2, offset: 10 });
  assert.equal(overflowDocs.length, 0, '超出范围时应返回空列表');

  // 3. 写入 7 条知识条目并验证条目分页与总数
  for (let i = 1; i <= 7; i++) {
    store.createKnowledgeItem({
      id: `item-page-${i}`,
      kind: 'rule',
      status: i <= 4 ? 'effective' : 'candidate',
      text: `Knowledge rule ${i}`,
      libraryId: libId,
    });
  }

  const totalItems = service.countItems(ctx);
  assert.equal(totalItems, 7, '条目总数统计应为 7');

  const effectiveTotal = service.countItems(ctx, 'effective');
  assert.equal(effectiveTotal, 4, '已生效条目总数应为 4');

  const candidateTotal = service.countItems(ctx, 'candidate');
  assert.equal(candidateTotal, 3, '候选条目总数应为 3');

  const page1Items = service.listItems(ctx, undefined, 3, 0);
  assert.equal(page1Items.length, 3, '条目第 1 页应返回 3 条');

  const page2Items = service.listItems(ctx, undefined, 3, 3);
  assert.equal(page2Items.length, 3, '条目第 2 页应返回 3 条');

  const page3Items = service.listItems(ctx, undefined, 3, 6);
  assert.equal(page3Items.length, 1, '条目第 3 页应返回 1 条');

  const candidatePageItems = service.listItems(ctx, 'candidate', 2, 0);
  assert.equal(candidatePageItems.length, 2, '候选条目第 1 页应返回 2 条');
});

test('P3-Scenario 15: 极简工程避坑备忘录与JIT触碰唤醒体系测试 (Minimal Guardrails & JIT Touch-Triggered Memory)', async (t) => {
  const env = createKnowledgeTestEnv(t);
  const store = env.store;
  const service = new KnowledgeService({
    dataDir: env.tempDir,
    store,
  });

  const ctx: KnowledgeContext = {
    workspaceId: 'ws-guardrails',
    workspacePath: env.tempDir,
    agentId: 'general',
    role: 'owner',
  };
  service.attachWorkspace(ctx);
  const projectLibId = 'project:ws-guardrails';

  // 1. 创建多层级作用域规约与避坑经验条目
  // 1.1 全局规约 (*)
  const itemGlobal = service.createItem(ctx, {
    text: '严禁向 Git 仓库提交敏感凭证、.env 文件与未经脱敏的内部 Token',
    applicability: '*',
    kind: 'rule',
    status: 'effective',
    libraryId: projectLibId,
  });

  // 1.2 模块前缀规约 (src/knowledge/)
  const itemModuleRule = service.createItem(ctx, {
    text: '数据库结构变更必须统一由 schema.ts 迁移驱动，严禁手写未注册的 DDL 表结构',
    applicability: 'src/knowledge/',
    kind: 'rule',
    status: 'effective',
    libraryId: projectLibId,
  });

  // 1.3 模块历史避坑经验 (src/knowledge/)
  const itemModuleExp = service.createItem(ctx, {
    text: 'SQLite 在高并发下可能有 SQLITE_BUSY 锁等待，必须统一配置 WAL 模式与 5000ms busyTimeout',
    applicability: 'src/knowledge/',
    kind: 'experience',
    status: 'effective',
    libraryId: projectLibId,
  });

  // 1.4 精确文件规约 (src/knowledge/store.ts)
  const itemExactFile = service.createItem(ctx, {
    text: 'findGuardrails 必须支持精确路径 > 最长前缀目录 > 全局通配符三级优先级排序',
    applicability: 'src/knowledge/store.ts',
    kind: 'rule',
    status: 'effective',
    libraryId: projectLibId,
  });

  // 1.5 候选状态条目 (candidate - 尚未生效，不应作为 JIT 契约唤醒)
  const itemCandidate = service.createItem(ctx, {
    text: '草稿备忘：考虑将向量嵌入切换为本地轻量级 ONNX 模型',
    applicability: 'src/knowledge/',
    kind: 'observation',
    status: 'candidate',
    libraryId: projectLibId,
  });

  // 2. 验证存储层与服务层前缀与精准匹配及优先级排序 (findGuardrails)
  // 当触碰 src/knowledge/store.ts 时，应匹配 itemExactFile (优先级 3) > itemModuleRule / itemModuleExp (优先级 2) > itemGlobal (优先级 1)
  const storeGuardrails = service.getGuardrails(ctx, 'src/knowledge/store.ts');
  assert.equal(storeGuardrails.length, 4, '应命中精确文件、前缀目录和全局 4 条已生效条目，忽略 candidate');
  assert.equal(storeGuardrails[0].id, itemExactFile.id, '精确匹配文件必须排在第 1 位');
  assert.ok(
    storeGuardrails[1].id === itemModuleRule.id || storeGuardrails[1].id === itemModuleExp.id,
    '模块前缀条目排在第 2/3 位'
  );
  assert.equal(storeGuardrails[3].id, itemGlobal.id, '全局通配符 * 必须排在最后');

  // 当触碰 src/knowledge/service.ts 时，不命中 itemExactFile，但命中模块前缀和全局
  const serviceGuardrails = service.getGuardrails(ctx, 'src/knowledge/service.ts');
  assert.equal(serviceGuardrails.length, 3, '应命中模块前缀 2 条与全局 1 条');
  assert.ok(!serviceGuardrails.some((g) => g.id === itemExactFile.id), '不应命中无关的精确文件规约');

  // 当触碰完全无关的路径 docs/readme.md 时，仅命中全局 *
  const docsGuardrails = service.getGuardrails(ctx, 'docs/readme.md');
  assert.equal(docsGuardrails.length, 1, '无关路径仅命中全局 * 规约');
  assert.equal(docsGuardrails[0].id, itemGlobal.id);

  // 3. 验证防御性契约备忘录格式化输出 (getJitGuardrails)
  const memo = service.getJitGuardrails(ctx, 'src/knowledge/store.ts');
  assert.ok(memo, '应生成 JIT 备忘录文本');
  assert.ok(memo.includes('[PROJECT MEMO: src/knowledge/store.ts]'), '包含契约标题');
  assert.ok(memo.includes('⚠️ 核心约束 (Rules/Decisions):'), '包含约束小节');
  assert.ok(memo.includes('💡 历史避坑 (Experiences/Anti-patterns):'), '包含避坑经验小节');
  assert.ok(memo.includes('SQLITE_BUSY 锁等待'), '包含经验条目正文');
  assert.ok(!memo.includes('草稿备忘'), '不得包含未生效的 candidate 条目');

  // 4. 验证 JIT Hook 触碰拦截与会话防刷屏去重机制 (createJitGuardrailHook)
  const { hook, resetSession, touchedScopes } = createJitGuardrailHook({
    knowledgeService: service,
    getContext: () => ctx,
    deduplicatePerSession: true,
  });

  // 4.1 模拟工具 read_file 首次读取 src/knowledge/store.ts
  const firstReadRes = await hook(
    'read_file',
    { path: 'src/knowledge/store.ts' },
    'export class KnowledgeStore { ... }'
  );
  assert.equal(firstReadRes.action, 'modify', '首次触碰应返回 modify 动作注入备忘录');
  assert.ok((firstReadRes as any).modifiedOutput.includes('[PROJECT MEMO: src/knowledge/store.ts]'));
  assert.ok((firstReadRes as any).modifiedOutput.startsWith('export class KnowledgeStore'));

  // 验证 touchedScopes 记录了触碰过的作用域
  assert.ok(touchedScopes.has('src/knowledge/store.ts'));
  assert.ok(touchedScopes.has('src/knowledge/'));
  assert.ok(touchedScopes.has('*'));

  // 4.2 模拟连续读取或编辑同一模块内文件（防刷屏去重）
  const secondReadRes = await hook(
    'read_file',
    { path: 'src/knowledge/service.ts' },
    'export class KnowledgeService { ... }'
  );
  assert.equal(secondReadRes.action, 'allow', '同一会话内相同作用域再次触碰应静默放行，避免刷屏');

  // 4.3 模拟修改已触碰过的文件
  const editRes = await hook(
    'edit_file',
    { path: 'src/knowledge/store.ts' },
    'File edited successfully'
  );
  assert.equal(editRes.action, 'allow', '编辑已提示过的模块应放行');

  // 4.4 会话重置 (例如开启新会话或新轮次任务)
  resetSession();
  assert.equal(touchedScopes.size, 0, '会话作用域记录已清空');

  const afterResetReadRes = await hook(
    'read_file',
    { path: 'src/knowledge/service.ts' },
    'service code'
  );
  assert.equal(afterResetReadRes.action, 'modify', '会话重置后可重新唤醒契约注入');

  // 5. 验证 RPC 调度与 record_guardrail 智能体工具端到端沉淀
  const rpc = createKnowledgeRpcDispatcher(service, ctx);
  const tools = createKnowledgeTools(rpc);
  const recordTool = tools.find((t) => t.name === 'record_guardrail');
  assert.ok(recordTool, 'record_guardrail 工具已注册');

  const toolExecResult = await recordTool.execute({
    applicability: 'web/knowledge/',
    kind: 'experience',
    rule: '知识条目列表渲染时必须保护空列表，不得对负索引执行数学运算',
    rationale: '在空数据下曾出现 Math.max(0, ...) 缺失导致的越界报错',
  });
  assert.ok(toolExecResult.includes('已成功沉淀工程守则备忘'), '工具执行成功返回确认信息');

  // 验证沉淀后即刻生效并可被 JIT 检索感知
  const webGuardrails = service.getGuardrails(ctx, 'web/knowledge/views.js');
  assert.ok(
    webGuardrails.some((g) => g.text.includes('知识条目列表渲染时必须保护空列表')),
    '新沉淀的避坑备忘应立即可被 web/knowledge/views.js 触碰唤醒'
  );

  // 6. 验证条目管理 (Update & Delete)
  const itemsBefore = service.listItems(ctx);
  const targetItem = itemsBefore.find((i) => i.text.includes('知识条目列表渲染时必须保护空列表'));
  assert.ok(targetItem, '找到待更新条目');

  // 更新条目
  const updatedItem = service.updateItem(ctx, targetItem.id, {
    text: '知识条目列表渲染时必须保护空列表，且分页控件必须正确禁用上下页按钮',
    applicability: 'web/knowledge/',
    kind: 'rule',
  });
  assert.equal(updatedItem.text, '知识条目列表渲染时必须保护空列表，且分页控件必须正确禁用上下页按钮');
  assert.equal(updatedItem.kind, 'rule');

  // 删除条目
  const deleteSuccess = service.deleteItem(ctx, targetItem.id);
  assert.equal(deleteSuccess, true, '条目应成功删除');
  assert.equal(service.getItem(ctx, targetItem.id), null, '删除后查询应为 null');

  // 验证删除后不再出现在 JIT 触碰守则中
  const webGuardrailsAfterDel = service.getGuardrails(ctx, 'web/knowledge/views.js');
  assert.ok(
    !webGuardrailsAfterDel.some((g) => g.id === targetItem.id),
    '删除的条目不得再被 JIT 触碰命中'
  );
});


