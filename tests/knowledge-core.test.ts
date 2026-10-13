import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { createKnowledgeTestEnv, seedDocument } from './helpers/knowledge-fixture.js';
import { chunkWithSpans } from '../src/knowledge/chunks.js';
import { KnowledgeService } from '../src/knowledge/service.js';
import type { KnowledgeContext } from '../src/knowledge/types.js';
import type { CaptureInput } from '../src/knowledge/capture.js';
import { Runtime } from '../src/runtime/service.js';

test('Scenario 1: 长文变短文/删除后旧片段退出而历史原文可读', async (t) => {
  const env = createKnowledgeTestEnv(t);
  const store = env.store;

  const library = store.createLibrary({
    id: 'project:test-ws',
    name: 'Test Project Lib',
    description: 'Project library',
    scope: 'project',
    workspaceId: 'test-ws',
    role: 'project',
  });

  const source = store.createSource({
    id: 'src-1',
    libraryId: library.id,
    kind: 'managed',
    locator: 'docs/architecture.md',
    enabled: true,
  });

  // 1. 发布第一版长文（产生多个片段）
  const longParagraph = 'A'.repeat(1500) + '\n\n' + 'B'.repeat(1500);
  const chunksV1 = chunkWithSpans(longParagraph);
  assert.ok(chunksV1.length >= 2, 'Long text should yield at least 2 chunks');

  const first = store.publishRevision({
    sourceId: source.id,
    sourceKey: 'docs/architecture.md',
    content: longParagraph,
    hash: 'hash-v1',
    expectedPreviousRevisionId: null,
    chunks: chunksV1.map((c) => ({ text: c.text, span: c.span })),
  });

  assert.equal(store.currentChunks(first.documentId).length, chunksV1.length);
  const genAfterFirst = store.getGeneration();

  // 2. 更新为短文（只产生 1 个片段）
  const shortText = 'Short summary of architecture.';
  const chunksV2 = chunkWithSpans(shortText);
  assert.equal(chunksV2.length, 1);

  const second = store.publishRevision({
    sourceId: source.id,
    sourceKey: 'docs/architecture.md',
    content: shortText,
    hash: 'hash-v2',
    expectedPreviousRevisionId: first.revisionId,
    chunks: chunksV2.map((c) => ({ text: c.text, span: c.span })),
  });

  // 旧片段退出，当前片段只有 1 个
  const currentChunks = store.currentChunks(second.documentId);
  assert.equal(currentChunks.length, 1);
  assert.equal(currentChunks[0].text, shortText);

  // 但历史第一版原文依然可读取不可变内容
  const oldRev = store.readRevision(first.revisionId);
  assert.ok(oldRev);
  assert.equal(oldRev.content, longParagraph);

  // 3. 删除文档：索引中的片段清空，但历史版本依旧存在
  store.deleteDocument(second.documentId);
  assert.deepEqual(store.currentChunks(second.documentId), []);
  assert.ok(store.readRevision(first.revisionId));
  assert.ok(store.readRevision(second.revisionId));
  assert.ok(store.getGeneration() > genAfterFirst);
});

test('Scenario 2: 索引写入异常导致事务回滚、旧 activeRevision 和 generation 保持不变', async (t) => {
  const env = createKnowledgeTestEnv(t);
  const store = env.store;

  const library = store.createLibrary({
    id: 'project:test-ws',
    name: 'Test Project Lib',
    description: 'Project library',
    scope: 'project',
    workspaceId: 'test-ws',
    role: 'project',
  });

  const source = store.createSource({
    id: 'src-fault',
    libraryId: library.id,
    kind: 'managed',
    locator: 'docs/fault.md',
    enabled: true,
  });

  // 先正常发布版本 1
  const initialText = 'Normal content v1';
  const v1 = store.publishRevision({
    sourceId: source.id,
    sourceKey: 'docs/fault.md',
    content: initialText,
    hash: 'hash-initial',
    expectedPreviousRevisionId: null,
    chunks: chunkWithSpans(initialText).map((c) => ({ text: c.text, span: c.span })),
  });

  const genBefore = store.getGeneration();
  const chunksBefore = store.currentChunks(v1.documentId);
  assert.equal(chunksBefore.length, 1);

  // 在测试库增加 BEFORE INSERT ON chunks 触发器，对包含 FAULT_INJECTION 的文本抛出 RAISE(ABORT)
  store.db.exec(`
    CREATE TRIGGER trigger_test_fault
    BEFORE INSERT ON chunks
    FOR EACH ROW
    WHEN NEW.text LIKE '%FAULT_INJECTION%'
    BEGIN
      SELECT RAISE(ABORT, 'Simulated indexing disk or database failure');
    END;
  `);

  // 尝试发布触发故障的版本 2
  const faultText = 'Something with FAULT_INJECTION text';
  assert.throws(
    () => {
      store.publishRevision({
        sourceId: source.id,
        sourceKey: 'docs/fault.md',
        content: faultText,
        hash: 'hash-fault',
        expectedPreviousRevisionId: v1.revisionId,
        chunks: [{ text: faultText, span: { startOffset: 0, endOffset: faultText.length, startLine: 1, endLine: 1 } }],
      });
    },
    /Simulated indexing disk or database failure/
  );

  // 验证：事务已回滚，旧 activeRevision、generation 与当前片段完全保持不变
  const genAfter = store.getGeneration();
  assert.equal(genAfter, genBefore);

  const chunksAfter = store.currentChunks(v1.documentId);
  assert.equal(chunksAfter.length, 1);
  assert.equal(chunksAfter[0].text, initialText);
});

test('Scenario 3: 可控同步场景（忽略凭据、hash相同不重复embedding、修改/删除生效、watcher探针）', async (t) => {
  const env = createKnowledgeTestEnv(t);
  const wsDir = path.join(env.tempDir, 'workspace');
  fs.mkdirSync(path.join(wsDir, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(wsDir, 'keys'), { recursive: true });

  // 1. 创建合法文档与需要忽略的凭据文件
  const guidePath = path.join(wsDir, 'docs', 'guide.md');
  const envSecretPath = path.join(wsDir, '.env.local');
  const idRsaPath = path.join(wsDir, 'keys', 'id_rsa');

  fs.writeFileSync(guidePath, 'Guide initial content');
  fs.writeFileSync(envSecretPath, 'SECRET_KEY=123456');
  fs.writeFileSync(idRsaPath, 'PRIVATE_KEY_BYTES');

  let embedCount = 0;
  const mockEmbedder = async (texts: string[]) => {
    embedCount += texts.length;
    return texts.map(() => new Array(1024).fill(0.1));
  };

  const service = new KnowledgeService({
    dataDir: env.tempDir,
    store: env.store,
    embedderForWorkspace: () => mockEmbedder,
  });
  t.after(async () => {
    await service.close();
  });

  const ctx: KnowledgeContext = {
    workspaceId: 'test-sync-ws',
    workspacePath: wsDir,
    agentId: 'general',
    role: 'owner',
  };

  // 2. 发现来源：必须包含 guide.md，绝不包含凭据文件
  const proposals = await service.discoverSources(ctx);
  const locators = proposals.map((p) => p.locator);
  assert.ok(locators.some((loc) => loc.includes('guide.md')), 'Discovered should include docs/guide.md');
  assert.equal(locators.some((loc) => loc.includes('.env')), false, 'Must ignore .env');
  assert.equal(locators.some((loc) => loc.includes('id_rsa')), false, 'Must ignore id_rsa');

  const guideProposal = proposals.find((p) => p.locator.includes('guide.md'))!;
  assert.ok(guideProposal);

  // 3. 首次启用来源：执行同步与 watcher
  await service.enableSource(ctx, guideProposal.id);
  const initialEmbedCount = embedCount;
  assert.ok(initialEmbedCount > 0, 'Embedder should be called on initial sync');

  const doc = env.store.getDocument(guideProposal.id, 'docs/guide.md');
  assert.ok(doc);
  assert.ok(doc.activeRevisionId);
  const v1RevId = doc.activeRevisionId;

  // 4. hash 相同不重复计算 embedding
  await service.syncSource(ctx, guideProposal.id);
  assert.equal(embedCount, initialEmbedCount, 'Hash unchanged must not trigger embedding');

  // 5. 真实 watcher change 探针：修改文件并在有界 2 秒内等待增量生效
  await new Promise((r) => setTimeout(r, 50));
  const updatedContent = 'Guide updated content v2 with more details';
  fs.writeFileSync(guidePath, updatedContent);

  const start = Date.now();
  let v2Detected = false;
  while (Date.now() - start < 2000) {
    const currentDoc = env.store.getDocument(guideProposal.id, 'docs/guide.md');
    if (currentDoc && currentDoc.activeRevisionId && currentDoc.activeRevisionId !== v1RevId) {
      v2Detected = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  // 若系统 watcher 去抖或 OS 事件稍慢，驱动一次 localSync.waitForIdle 确保完成
  if (!v2Detected) {
    await service.localSync.waitForIdle();
    const currentDoc = env.store.getDocument(guideProposal.id, 'docs/guide.md');
    if (currentDoc && currentDoc.activeRevisionId && currentDoc.activeRevisionId !== v1RevId) {
      v2Detected = true;
    }
  }
  assert.ok(v2Detected, 'Watcher probe should detect file change within 2 seconds');
  assert.ok(embedCount > initialEmbedCount, 'Embedding count should increase on content change');

  // 6. 删除文件：验证删除生效，当前 chunks 清空
  fs.unlinkSync(guidePath);
  service.localSync.queueSourceChange(guideProposal.id, guidePath, 'unlink', wsDir);
  await service.localSync.waitForIdle();

  const deletedDoc = env.store.getDocument(guideProposal.id, 'docs/guide.md');
  assert.ok(deletedDoc);
  assert.equal(deletedDoc.activeRevisionId, null, 'Deleted doc active revision should be null');
  assert.deepEqual(env.store.currentChunks(deletedDoc.id), [], 'Deleted doc chunks should be empty');
});

test('Scenario 4: 范围隔离与 Worker IPC 往返（同路径项目隔离、伪造不扩大范围、图谱报错、真实 Worker IPC 回调）', async (t) => {
  const env = createKnowledgeTestEnv(t);
  const service = new KnowledgeService({
    dataDir: env.tempDir,
    store: env.store,
  });
  t.after(async () => {
    await service.close();
  });

  const mockSharedPath = path.join(env.tempDir, 'shared-project');
  fs.mkdirSync(mockSharedPath, { recursive: true });

  const ctxP1: KnowledgeContext = {
    workspaceId: 'p1',
    workspacePath: mockSharedPath,
    agentId: 'general',
    role: 'owner',
  };
  const ctxP2: KnowledgeContext = {
    workspaceId: 'p2',
    workspacePath: mockSharedPath,
    agentId: 'general',
    role: 'owner',
  };

  service.attachWorkspace(ctxP1);
  service.attachWorkspace(ctxP2);

  // 1. 在 P1 中摄入文档
  await service.dispatch(ctxP1, {
    op: 'ingest',
    input: {
      content: 'Project 1 Alpha Architecture Blueprint with modular plugins.',
      name: 'docs/spec.md',
      libraryId: 'project:p1',
    },
  });

  // 2. 在 P2 中摄入文档（相同相对路径 docs/spec.md）
  await service.dispatch(ctxP2, {
    op: 'ingest',
    input: {
      content: 'Project 2 Beta Secret Formula and classified credentials.',
      name: 'docs/spec.md',
      libraryId: 'project:p2',
    },
  });

  // 3. 在 public-basic 摄入公共文档
  let publicSource = env.store.getSource('src-public-basic');
  if (!publicSource) {
    publicSource = env.store.createSource({
      id: 'src-public-basic',
      libraryId: 'public-basic',
      kind: 'managed',
      locator: 'managed',
      enabled: true,
    });
  }
  const publicContent = 'General Company Coding Conventions and styling rules.';
  env.store.publishRevision({
    sourceId: publicSource.id,
    sourceKey: 'docs/common.md',
    content: publicContent,
    hash: 'hash-public',
    expectedPreviousRevisionId: null,
    chunks: [
      {
        text: publicContent,
        span: { startOffset: 0, endOffset: publicContent.length, startLine: 1, endLine: 1 },
        evidenceKind: 'document',
      },
    ],
  });

  // 4. 范围隔离验证：P1 检索 Alpha 能命中 P1
  const p1ResAlpha = (await service.dispatch(ctxP1, {
    op: 'search',
    input: { query: 'Alpha Architecture', mode: 'fact', topK: 5 },
  })) as any;
  assert.equal(p1ResAlpha.hits.length, 1);
  assert.equal(p1ResAlpha.hits[0].citation.sourceUri, 'docs/spec.md');
  assert.equal(p1ResAlpha.hits[0].citation.libraryId, 'project:p1');

  // P1 检索 Secret Formula 绝不能命中 P2
  const p1ResSecret = (await service.dispatch(ctxP1, {
    op: 'search',
    input: { query: 'Secret Formula', mode: 'fact', topK: 5 },
  })) as any;
  assert.equal(p1ResSecret.hits.length, 0, 'P1 must not see P2 documents');

  // P1 检索公共规范可命中 public-basic
  const p1ResPublic = (await service.dispatch(ctxP1, {
    op: 'search',
    input: { query: 'Coding Conventions', mode: 'fact', topK: 5 },
  })) as any;
  assert.equal(p1ResPublic.hits.length, 1);
  assert.equal(p1ResPublic.hits[0].citation.libraryId, 'public-basic');

  // P2 检索 Secret Formula 可命中 P2
  const p2ResSecret = (await service.dispatch(ctxP2, {
    op: 'search',
    input: { query: 'Secret Formula', mode: 'fact', topK: 5 },
  })) as any;
  assert.equal(p2ResSecret.hits.length, 1);
  const p2CitationId = p2ResSecret.hits[0].citation.id;

  // 5. 跨项目引用读取隔离：P1 读取 P2 引用报错 403
  assert.throws(
    () => service.citation(ctxP1, p2CitationId),
    /Citation access denied/
  );

  // 6. 伪造 libraryIds 不能扩大范围（过滤后返回空命中）
  const p1ForgedRes = (await service.dispatch(ctxP1, {
    op: 'search',
    input: { query: 'Secret Formula', mode: 'fact', topK: 5, libraryIds: ['project:p2'] },
  })) as any;
  assert.equal(p1ForgedRes.hits.length, 0, 'Forged libraryIds must be filtered out and return empty hits');

  // 未知 libraryId 报错
  await assert.rejects(
    async () =>
      service.dispatch(ctxP1, {
        op: 'search',
        input: { query: 'test', mode: 'fact', topK: 5, libraryIds: ['unknown-non-existent-lib'] },
      }),
    /未知知识库 ID/
  );

  // 7. 图谱请求遵守范围隔离，未知实体返回空图谱，不回退全库
  const graphRes = (await service.dispatch(ctxP1, {
    op: 'graph',
    input: { entityId: 'E1', hops: 1 },
  })) as any;
  assert.equal(graphRes.nodes.length, 0, '未知实体或无权限时不回退全库');
  assert.equal(graphRes.edges.length, 0);

  // 8. 复用现有 worker fixture 验证真实 worker IPC 往返回到主服务
  const mockServer = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    const results = input.messages.filter((m: any) => m.role === 'tool');
    let calls: Array<{ name: string; arguments: unknown }> = [];
    if (!results.length) {
      calls = [{ name: 'rag_search', arguments: { query: 'Alpha Architecture' } }];
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const delta = calls.length
      ? {
          tool_calls: calls.map((call, index) => ({
            index,
            id: `call-${index}`,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
        }
      : { content: 'search completed' };
    const chunk = (val: unknown) => response.write(`data: ${JSON.stringify(val)}\n\n`);
    chunk({
      id: 'mock-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'fixture',
      choices: [{ index: 0, delta, finish_reason: null }],
    });
    chunk({
      id: 'mock-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'fixture',
      choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    });
    response.end('data: [DONE]\n\n');
  });

  await new Promise<void>((resolve, reject) => {
    mockServer.once('error', reject);
    mockServer.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => {
    mockServer.close();
  });

  const address = mockServer.address();
  assert.ok(address && typeof address !== 'string');

  const workerTestDir = path.join(env.tempDir, 'worker-test-ws');
  fs.mkdirSync(workerTestDir, { recursive: true });
  fs.writeFileSync(
    path.join(workerTestDir, 'cheese-agent.config.json'),
    JSON.stringify({
      model: {
        provider: 'openai',
        name: 'fixture',
        apiKey: 'fixture-key',
        baseURL: `http://127.0.0.1:${address.port}/v1`,
      },
      rag: { enabled: true },
    })
  );

  const runtime = new Runtime(path.join(workerTestDir, 'state'));
  t.after(async () => {
    await runtime.close();
  });

  const ws = runtime.addWorkspace(workerTestDir);
  // 在当前 runtime 的 knowledgeService 中导入文档
  await runtime.knowledgeService.dispatch(
    {
      workspaceId: ws.id,
      workspacePath: workerTestDir,
      agentId: 'general',
      role: 'owner',
    },
    {
      op: 'ingest',
      input: {
        content: 'Alpha Architecture Document in Worker Runtime Workspace',
        name: 'docs/alpha.md',
        libraryId: `project:${ws.id}`,
      },
    }
  );

  const session = runtime.createSession(ws.id);
  const run = runtime.submit(session.id, '请检索相关知识', 'req-knowledge-1');
  await runtime.idle();

  assert.equal(run.status, 'completed', run.error);
  const events = runtime.events(run.id);

  // 确认在真实 worker 中执行了 rag_search 工具，且 IPC 回到了主服务并触发了 knowledge-used 事件
  const knowledgeUsedEvent = events.find((e) => e.type === 'knowledge-used');
  assert.ok(knowledgeUsedEvent, 'Must emit knowledge-used event via IPC from worker');
  const toolResultEvent = events.find((e) => e.type === 'tool-result' && e.name === 'rag_search');
  assert.ok(toolResultEvent, 'Worker must execute rag_search tool through IPC');
  assert.match(String(toolResultEvent?.output), /Alpha Architecture Document/);
});

test('Scenario 5: TS/JS 代码结构索引与局部图谱合并与隔离', async (t) => {
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

  // 1. 在 P1 中导入四个代码文件
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

  // 2. 验证：两个文件同名函数不合并 (fileA.ts 的 calculate 与 fileB.ts 的 calculate 是独立实体)
  const calcEntities = store.db.prepare(`
    SELECT * FROM entities WHERE name = 'calculate' AND workspace_id = 'ws-p1'
  `).all() as any[];
  assert.equal(calcEntities.length, 2, '两个文件的同名函数不合并');
  assert.notEqual(calcEntities[0].id, calcEntities[1].id, '不同文件的实体 ID 必须区分');
  assert.notEqual(calcEntities[0].path, calcEntities[1].path);

  // 3. 验证：import 路径与行号准确
  const importEdges = store.db.prepare(`
    SELECT * FROM edges WHERE source_id LIKE '%fileA.ts%' AND kind = 'imports'
  `).all() as any[];
  assert.ok(importEdges.length > 0, 'fileA.ts 必须存在 imports 边');
  const edgeEvidences = store.db.prepare(`
    SELECT * FROM edge_evidence WHERE edge_id = ?
  `).all(importEdges[0].id) as any[];
  assert.ok(edgeEvidences.length > 0, '边必须具备版本证据');
  assert.equal(edgeEvidences[0].start_line, 1, 'import 语句起始行号准确为 1');
  assert.equal(edgeEvidences[0].end_line, 1, 'import 语句结束行号准确为 1');

  // 插入候选语义边 (模型推断候选)
  const candEdgeId = 'cand-edge-semantic-1';
  store.db.prepare(`
    INSERT INTO edges (id, source_id, target_id, kind, status, library_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(candEdgeId, calcEntities[0].id, calcEntities[1].id, 'explains', 'candidate', p1Lib.id);

  // 4. 验证：修改依赖后旧边退出，共享目标仍存在；候选语义边保留状态
  const updatedFileAContent = `import { other } from './other.ts';
export function calculate(): number {
  return other();
}`;
  await service.dispatch(ctxP1, {
    op: 'ingest',
    input: { content: updatedFileAContent, name: 'fileA.ts', libraryId: p1Lib.id },
  });

  // 检查旧的 fileA -> shared 边已退出
  const oldImportEdge = store.db.prepare(`
    SELECT * FROM edges WHERE source_id LIKE '%fileA.ts%' AND target_id LIKE '%shared.ts%'
  `).all();
  assert.equal(oldImportEdge.length, 0, '修改依赖后旧边必须退出图谱');

  // 共享目标 shared.ts 及其实体仍然存在
  const sharedEntities = store.db.prepare(`
    SELECT * FROM entities WHERE path = 'shared.ts'
  `).all();
  assert.ok(sharedEntities.length > 0, '共享目标 shared.ts 实体仍应保留');

  // fileC.ts -> shared.ts 的边仍然存在
  const cToSharedEdges = store.db.prepare(`
    SELECT * FROM edges WHERE source_id LIKE '%fileC.ts%' AND target_id LIKE '%shared.ts%'
  `).all();
  assert.ok(cToSharedEdges.length > 0, 'fileC.ts 对 shared.ts 的依赖边仍保留');

  // 候选语义边保留候选状态
  const candRow = store.db.prepare(`SELECT * FROM edges WHERE id = ?`).get(candEdgeId) as any;
  assert.ok(candRow, '候选语义边必须保留');
  assert.equal(candRow.status, 'candidate', '候选语义边必须保留 candidate 状态');

  // 5. 验证：超限显示 truncated (hops=1 上限 60 节点)
  const hubNodeId = 'ws-p1:hub.ts:::file:hub.ts';
  store.db.prepare(`
    INSERT INTO entities (id, workspace_id, path, kind, name, library_id, revision_id, start_offset, end_offset, start_line, end_line)
    VALUES (?, 'ws-p1', 'hub.ts', 'file', 'hub.ts', 'project:ws-p1', 'rev-hub', 0, 100, 1, 10)
  `).run(hubNodeId);

  // 构造 65 个相连实体和边
  for (let i = 0; i < 65; i++) {
    const spokeId = `ws-p1:spoke${i}.ts:::file:spoke${i}.ts`;
    store.db.prepare(`
      INSERT INTO entities (id, workspace_id, path, kind, name, library_id, revision_id, start_offset, end_offset, start_line, end_line)
      VALUES (?, 'ws-p1', 'spoke${i}.ts', 'file', 'spoke${i}.ts', 'project:ws-p1', 'rev-hub', 0, 10, 1, 1)
    `).run(spokeId);
    store.db.prepare(`
      INSERT INTO edges (id, source_id, target_id, kind, status, library_id)
      VALUES (?, ?, ?, 'imports', 'effective', 'project:ws-p1')
    `).run(`edge-hub-${i}`, hubNodeId, spokeId);
  }

  const hubView = service.graph(ctxP1, hubNodeId, 1);
  assert.equal(hubView.truncated, true, '超过 60 个节点时 truncated 必须为 true');
  assert.equal(hubView.nodes.length, 60, '默认 1 跳最多返回 60 个节点');

  // 6. 验证：P1 图查询不能访问 P2 实体和证据
  const p2SecretContent = `export function secretAlgorithm(): number {
  return 99999;
}`;
  await service.dispatch(ctxP2, {
    op: 'ingest',
    input: { content: p2SecretContent, name: 'secret.ts', libraryId: p2Lib.id },
  });

  const p2SecretEntity = store.db.prepare(`
    SELECT * FROM entities WHERE name = 'secretAlgorithm' AND workspace_id = 'ws-p2'
  `).get() as any;
  assert.ok(p2SecretEntity, 'P2 实体必须成功建立');

  // P1 试图查询 P2 的实体 ID
  const p1QueryP2 = service.graph(ctxP1, p2SecretEntity.id, 1);
  assert.equal(p1QueryP2.nodes.length, 0, 'P1 图查询绝对无法访问 P2 的实体');
  assert.equal(p1QueryP2.edges.length, 0, 'P1 图查询绝对无法访问 P2 的边');

  // P1 总览图谱中绝对不包含 P2 的实体
  const p1Overview = service.graph(ctxP1);
  assert.ok(
    !p1Overview.nodes.some((n) => n.name === 'secretAlgorithm' || n.path === 'secret.ts'),
    'P1 总览中绝对不能泄露 P2 的代码实体'
  );
});

test('Scenario 6: 自动沉淀、同 run 去重、显式决定与可信执行记录', async (t) => {
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

  // 1. 构造含有执行证据的输入：
  // - 一条 exitCode = 0 且无超时的成功命令
  // - 一条 timedOut = true 的超时命令
  // - 一条 exitCode = 1 的失败命令
  // - 用户明确决定
  // - 歧义推荐语句
  // - 模型的自证链（经测试代码完全正确...）以及一条标准建议
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

  // 1. 触发 enqueueCapture
  service.enqueueCapture(ctx, input1);
  await service.captureQueue.waitForRun(runId1);

  // 2. 验证：同 run 去重 (再次 enqueueCapture 同一 runId)
  service.enqueueCapture(ctx, input1);
  // 检查作业表中仅有一条记录
  const jobRows = store.db.prepare('SELECT * FROM capture_jobs WHERE run_id = ?').all(runId1);
  assert.equal(jobRows.length, 1, '同 runId 作业必须去重');

  const itemsRun1 = service.listItems(ctx);

  // 3. 验证：用户明确决定生效
  const decisionItem = itemsRun1.find((i) => i.kind === 'decision');
  assert.ok(decisionItem, '用户明确决定必须被提取');
  assert.equal(decisionItem.status, 'effective', '明确决定必须是 effective 状态');
  assert.ok(decisionItem.text.includes('TypeScript 严格模式'));

  // 4. 验证：exitCode = 0 的观察生效且保持环境范围
  const successObs = itemsRun1.find((i) => i.evidenceIds.includes('exec-success-01'));
  assert.ok(successObs, 'exitCode=0 的命令必须生成观察');
  assert.equal(successObs.kind, 'observation');
  assert.equal(successObs.status, 'effective', '成功执行命令必须是 effective 状态');
  assert.equal(successObs.applicability, env.tempDir, '观察必须保留环境 cwd 范围');
  assert.ok(successObs.text.includes('pnpm test'));

  // 5. 验证：超时/返回错误文本不生效 (不生成 effective observation)
  const timeoutObs = itemsRun1.find((i) => i.evidenceIds.includes('exec-timeout-02'));
  assert.equal(timeoutObs, undefined, '超时执行绝对不能生成 effective 观察');
  const failedObs = itemsRun1.find((i) => i.evidenceIds.includes('exec-failed-03'));
  assert.equal(failedObs, undefined, '失败执行绝对不能生成 effective 观察');

  // 6. 验证：模型自证链拒绝成为核验依据；普通建议为 candidate 状态
  const selfClaimObs = itemsRun1.find(
    (i) => i.text.includes('经测试代码完全正确') || i.text.includes('绝对可靠')
  );
  assert.equal(selfClaimObs, undefined, '模型自证链语句绝对不能被采纳为事实或决定');

  const candidateExp = itemsRun1.find((i) => i.text.includes('在 CI 中加入 pnpm typecheck'));
  assert.ok(candidateExp, '助手建议必须被提取为经验');
  assert.equal(candidateExp.status, 'candidate', '助手建议必须保持 candidate 候选状态');

  // 7. 验证：歧义推荐仍为候选
  const runId2 = 'run-test-002';
  const input2: CaptureInput = {
    runId: runId2,
    sessionId: 'session-002',
    workspaceId: 'ws-capture',
    userInput: '建议未来可能考虑把架构拆成微服务？',
    messages: [],
    events: [],
    environment: { cwd: env.tempDir, runtimeVersion: '1.0.0' },
  };
  service.enqueueCapture(ctx, input2);
  await service.captureQueue.waitForRun(runId2);

  const itemsRun2 = service.listItems(ctx);
  const ambigItem = itemsRun2.find((i) => i.originRunId === runId2);
  assert.ok(ambigItem, '歧义输入必须被提取');
  assert.equal(ambigItem.status, 'candidate', '歧义推荐必须保持 candidate 状态');

  // 8. 验证：条目纠错 (correctItem)
  const corrected = service.correctItem(
    ctx,
    decisionItem.id,
    '修正为：前端统一严格模式，Node 脚本暂时宽松'
  );
  assert.equal(corrected.status, 'effective', '纠错后的新条目必须为 effective');
  assert.equal(corrected.supersedes, decisionItem.id, '新条目必须记录 supersedes 旧条目 ID');

  const oldItemAfter = store.getKnowledgeItem(decisionItem.id);
  assert.equal(oldItemAfter?.status, 'invalidated', '被纠正的旧条目必须变为 invalidated');
});
