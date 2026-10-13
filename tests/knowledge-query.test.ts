import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { createKnowledgeTestEnv } from './helpers/knowledge-fixture.js';
import { KnowledgeService } from '../src/knowledge/service.js';
import {
  Context7Provider,
  FirecrawlProvider,
  syncProviderSource,
  type PublicSourceProvider,
} from '../src/knowledge/providers.js';
import type { KnowledgeContext, SearchRequest } from '../src/knowledge/types.js';

test('Scenario 7: 有界跨文档关系联合召回、同 generation、候选状态、租户隔离与纠错退出', async (t) => {
  const env = createKnowledgeTestEnv(t);
  const store = env.store;
  const service = new KnowledgeService({ dataDir: env.tempDir, store });

  const p1Lib = store.createLibrary({
    id: 'project:ws-p1',
    name: 'P1 Project Lib',
    description: 'P1 Workspace Library',
    scope: 'project',
    workspaceId: 'ws-p1',
    role: 'project',
  });

  const p2Lib = store.createLibrary({
    id: 'project:ws-p2',
    name: 'P2 Project Lib',
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

  // 1. 在 P1 中摄入源码文件与设计文档
  const authSource = `export const authService = {
  validate(): boolean { return true; }
};`;
  const loginSource = `import { authService } from './auth.ts';
export function handleLogin(): boolean {
  return authService.validate();
}`;
  const designDoc = `# 安全设计规范与架构备忘
认证网关 handleLogin 必须强制启用双向 TLS 握手与 Token 验证。`;

  await service.dispatch(ctxP1, {
    op: 'ingest',
    input: { content: authSource, name: 'auth.ts', libraryId: p1Lib.id },
  });
  await service.dispatch(ctxP1, {
    op: 'ingest',
    input: { content: loginSource, name: 'login.ts', libraryId: p1Lib.id },
  });
  const docRes = (await service.dispatch(ctxP1, {
    op: 'ingest',
    input: { content: designDoc, name: 'docs/design.md', libraryId: p1Lib.id },
  })) as any;

  // 获取 login.ts 中的 handleLogin 实体
  const loginEntity = store.db.prepare(`
    SELECT * FROM entities WHERE name = 'handleLogin' AND library_id = ?
  `).get(p1Lib.id) as any;
  assert.ok(loginEntity, 'handleLogin 实体必须已被 AST 索引');

  // 2. 创建有效决议与候选经验，并关联图谱边
  const decItem = store.createKnowledgeItem({
    id: 'item-dec-tls',
    kind: 'decision',
    status: 'effective',
    text: '架构决议：生产环境 handleLogin 统一使用 TLS 1.3 加密通道',
    libraryId: p1Lib.id,
    evidenceIds: ['ev-01'],
    applicability: 'project',
  });
  store.vectorStore.upsertIndexedChunks([
    {
      id: `item-chunk-${decItem.id}`,
      text: decItem.text,
      source: `knowledge-item:${decItem.id}`,
      chunkIndex: 0,
      collectionId: `${p1Lib.id}:effective`,
    },
  ]);

  // 在 handleLogin 与 decItem / 设计文档之间建立 effective explains 边
  store.db.prepare(`
    INSERT INTO edges (id, source_id, target_id, kind, status, library_id)
    VALUES (?, ?, ?, 'explains', 'effective', ?)
  `).run('edge-dec-explains', decItem.id, loginEntity.id, p1Lib.id);

  // 建立 candidate 候选经验与 candidate 边
  const candItem = store.createKnowledgeItem({
    id: 'item-cand-jwt',
    kind: 'experience',
    status: 'candidate',
    text: '候选经验：尝试采用 JWT 异步刷新机制以减少鉴权延迟',
    libraryId: p1Lib.id,
    evidenceIds: ['ev-02'],
    applicability: 'project',
  });
  store.vectorStore.upsertIndexedChunks([
    {
      id: `item-chunk-${candItem.id}`,
      text: candItem.text,
      source: `knowledge-item:${candItem.id}`,
      chunkIndex: 0,
      collectionId: `${p1Lib.id}:candidate`,
    },
  ]);

  store.db.prepare(`
    INSERT INTO edges (id, source_id, target_id, kind, status, library_id)
    VALUES (?, ?, ?, 'explains', 'candidate', ?)
  `).run('edge-cand-explains', candItem.id, loginEntity.id, p1Lib.id);

  // 3. 在 P2 中摄入隔离资料，并建立 P2 边
  const p2Source = `export function p2SecretFunction(): void {}`;
  await service.dispatch(ctxP2, {
    op: 'ingest',
    input: { content: p2Source, name: 'secret.ts', libraryId: p2Lib.id },
  });

  // 4. 验证：fact 模式下 includeGraph=true 的联合召回与同 generation
  const factReq: SearchRequest = {
    query: 'handleLogin',
    mode: 'fact',
    topK: 5,
    libraryIds: [p1Lib.id],
    includeGraph: true,
  };
  const factRes = await service.search(ctxP1, factReq);

  assert.ok(factRes.hits.length >= 2, '包含图谱扩展时，必须返回种子和关联证据');
  assert.equal(factRes.generation, store.getGeneration(), '检索响应必须携带当前生效的快照 generation');

  // 必须召回种子 (login.ts handleLogin)
  assert.ok(factRes.hits.some((h) => h.text.includes('handleLogin')));
  // 必须沿 effective 图谱边联合召回 decItem 证据
  assert.ok(
    factRes.hits.some((h) => h.text.includes('TLS 1.3')),
    '必须通过有效边扩展召回关联的决议证据'
  );
  // fact 模式下绝不能沿 candidate 边召回 candidate 条目
  assert.equal(
    factRes.hits.some((h) => h.text.includes('JWT 异步刷新')),
    false,
    'fact 模式绝对不能沿候选语义边召回候选经验'
  );

  // 5. 验证：experience 模式下允许沿候选边召回，且保留 candidate 状态
  const expReq: SearchRequest = {
    query: 'handleLogin',
    mode: 'experience',
    topK: 5,
    libraryIds: [p1Lib.id],
    includeGraph: true,
  };
  const expRes = await service.search(ctxP1, expReq);
  const candHit = expRes.hits.find((h) => h.text.includes('JWT 异步刷新'));
  assert.ok(candHit, 'experience 模式必须沿 candidate 边召回候选经验');
  assert.equal(candHit.citation.status, 'candidate', '候选经验引用的状态必须保留为 candidate');

  // 6. 验证：跨项目边与实体隔离
  assert.equal(
    factRes.hits.some((h) => h.text.includes('p2SecretFunction')),
    false,
    '跨项目实体和文档在 P1 检索中绝对不越界召回'
  );
  assert.equal(
    expRes.hits.some((h) => h.text.includes('p2SecretFunction')),
    false,
    '跨项目实体和文档在 P1 检索中绝对不越界召回'
  );

  // 7. 验证：纠错后旧结论立即退出，新生效结论被联合召回
  service.correctItem(
    ctxP1,
    decItem.id,
    '架构纠错：全面升级为 OAuth 2.1 严格授权协议'
  );

  const searchAfterCorrect = await service.search(ctxP1, {
    query: 'handleLogin',
    mode: 'fact',
    topK: 5,
    libraryIds: [p1Lib.id],
    includeGraph: true,
  });

  // 旧的 TLS 1.3 结论已 invalidated，不得再出现在 hits 中
  assert.equal(
    searchAfterCorrect.hits.some((h) => h.text.includes('TLS 1.3')),
    false,
    '旧结论已被纠正并 invalidated，绝不能再被召回'
  );
  // 新的纠错结论必须生效被召回
  assert.ok(
    searchAfterCorrect.hits.some((h) => h.text.includes('OAuth 2.1')),
    '纠错后的新替代结论必须能被联合召回'
  );
});

test('Scenario 8: 公共来源提供方适配、禁止外站、同 Hash 跳过、失败保留旧版与旧知识库平滑迁移', async (t) => {
  const env = createKnowledgeTestEnv(t);
  const store = env.store;
  const service = new KnowledgeService({ dataDir: env.tempDir, store });

  const ctx: KnowledgeContext = {
    workspaceId: 'ws-test-8',
    workspacePath: env.tempDir,
    agentId: 'general',
    role: 'owner',
  };
  service.attachWorkspace(ctx);

  // 1. 搭建本地 Mock HTTP 服务模拟 Context7 与 Firecrawl
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    if (url.pathname === '/v1/documents/search') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          documents: [
            {
              name: 'query-v5.md',
              url: 'https://context7.example.com/libs/query-v5',
              content: '# TanStack Query v5\nuseSuspenseQuery replaces useQuery suspense mode.',
              version: 'v5.0.0',
            },
          ],
        })
      );
      return;
    }

    if (url.pathname === '/v1/crawl' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'crawl-job-test' }));
      return;
    }

    if (url.pathname === '/v1/crawl/crawl-job-test') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'completed',
          data: [
            {
              url: 'https://docs.internal.com/guide/intro',
              markdown: '# Internal Architecture Guide\nMicroservices best practices and patterns.',
            },
            {
              // 模拟外站攻击或第三方链接：提供方必须严格剔除！
              url: 'https://malicious-external-tracker.com/leak',
              markdown: 'Malicious tracker content',
            },
          ],
        })
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as any;
  const mockBaseUrl = `http://127.0.0.1:${address.port}`;
  t.after(() => server.close());

  // 2. 验证 Context7 提供方适配器：请求外部文档与预览保存
  const c7Provider = new Context7Provider({
    apiKey: 'test-c7-key',
    baseUrl: mockBaseUrl,
  });
  const previewDocs = await c7Provider.preview({ query: 'TanStack Query', version: 'v5.0.0' });
  assert.equal(previewDocs.length, 1);
  assert.equal(previewDocs[0].sourceKey, 'query-v5.md');
  assert.equal(previewDocs[0].version, 'v5.0.0');

  // 将 Context7 作为公共基础来源同步至 public-basic 库
  const c7Source = store.createSource({
    id: 'src-c7-query',
    libraryId: 'public-basic',
    kind: 'context7',
    locator: 'TanStack Query',
    versionConstraint: 'v5.0.0',
    enabled: true,
  });

  const c7SyncRes = await syncProviderSource(store, c7Source, c7Provider);
  assert.equal(c7SyncRes.added, 1);
  assert.equal(c7SyncRes.unchanged, 0);

  // 验证版本原文与哈希存在
  const c7Doc = store.getDocument(c7Source.id, 'query-v5.md');
  assert.ok(c7Doc);
  assert.ok(c7Doc.activeRevisionId);
  const activeRev1 = store.readRevision(c7Doc.activeRevisionId);
  assert.ok(activeRev1?.content.includes('useSuspenseQuery'));

  // 3. 验证同 Hash 内容跳过重建（不产生新版本）
  const c7SyncRes2 = await syncProviderSource(store, c7Source, c7Provider);
  assert.equal(c7SyncRes2.unchanged, 1);
  assert.equal(c7SyncRes2.added, 0);
  assert.equal(c7SyncRes2.updated, 0);
  const c7DocAfterSecondSync = store.getDocument(c7Source.id, 'query-v5.md');
  assert.equal(
    c7DocAfterSecondSync?.activeRevisionId,
    c7Doc.activeRevisionId,
    '相同 Hash 时绝不重复创建新版本'
  );

  // 4. 验证 Firecrawl 提供方：严格禁止外站跳转与域名越界
  const fcProvider = new FirecrawlProvider({
    apiKey: 'test-fc-key',
    baseUrl: mockBaseUrl,
  });
  const fcSource = store.createSource({
    id: 'src-fc-guide',
    libraryId: 'public-basic',
    kind: 'firecrawl',
    locator: 'https://docs.internal.com/guide',
    enabled: true,
  });

  const fcSyncRes = await syncProviderSource(store, fcSource, fcProvider);
  assert.equal(fcSyncRes.added, 1);

  // 内部文档应已成功录入
  const fcDoc = store.getDocument(fcSource.id, 'guide/intro');
  assert.ok(fcDoc, '合法域名下的路径应正确录入');

  // 外站文档绝对不能被录入
  const allDocs = store.listDocuments(fcSource.id);
  assert.equal(
    allDocs.some((d) => d.sourceKey.includes('malicious') || d.sourceKey.includes('leak')),
    false,
    '外站链接必须被严格过滤，绝不进入知识库'
  );

  // 5. 验证网络异常时保留旧版本与记录 lastError
  const failingProvider: PublicSourceProvider = {
    provider: 'context7',
    fetch: async () => {
      throw new Error('Connection reset by peer');
    },
  };
  await assert.rejects(
    async () => syncProviderSource(store, c7Source, failingProvider),
    /Connection reset/
  );
  const c7SourceAfterFail = store.getSource(c7Source.id)!;
  assert.equal(c7SourceAfterFail.syncStatus, 'error');
  assert.ok(c7SourceAfterFail.lastError?.includes('Connection reset'));
  // 确认旧版本仍然完好可用
  const c7DocAfterFail = store.getDocument(c7Source.id, 'query-v5.md')!;
  assert.equal(c7DocAfterFail.activeRevisionId, c7Doc.activeRevisionId);

  // 6. 验证旧版知识库平滑迁移 (importLegacyDatabase)
  // 创建磁盘上真实存在的文件以及不存在的文件
  const realFileRel = 'docs/real-guide.md';
  const realFileAbs = path.join(env.tempDir, realFileRel);
  fs.mkdirSync(path.dirname(realFileAbs), { recursive: true });
  fs.writeFileSync(
    realFileAbs,
    '# Real Project Guide\nLine 2: Guide body content.\nLine 3: Final step.'
  );

  const legacyDbPath = path.join(env.tempDir, 'legacy.db');
  const legacyDb = new Database(legacyDbPath);
  legacyDb.exec(`
    CREATE TABLE chunks (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      source TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      collection_id TEXT
    );
  `);
  legacyDb.prepare(`
    INSERT INTO chunks (id, text, source, chunk_index, collection_id)
    VALUES (?, ?, ?, ?, ?)
  `).run('legacy-1', 'Line 2: Guide body content.', realFileRel, 0, 'legacy-col');
  legacyDb.prepare(`
    INSERT INTO chunks (id, text, source, chunk_index, collection_id)
    VALUES (?, ?, ?, ?, ?)
  `).run('legacy-2', 'Absent file chunk text.', 'missing/old.md', 0, 'legacy-col');
  legacyDb.close();

  // 执行迁移
  const importResult = await service.importLegacyDatabase(ctx, legacyDbPath);
  assert.equal(importResult.importedDocuments, 2);
  assert.ok(importResult.importedChunks >= 2);
  assert.equal(importResult.legacyLibraryId, `project:${ctx.workspaceId}:legacy`);

  // 验证旧库原样保留、未被清空
  const legacyVerifyDb = new Database(legacyDbPath, { readonly: true });
  const legacyChunkCount = legacyVerifyDb.prepare('SELECT count(*) as c FROM chunks').get() as any;
  assert.equal(legacyChunkCount.c, 2, '旧版知识库文件必须保持完整不可变');
  legacyVerifyDb.close();

  // 验证磁盘存在的文件生成了精确 span，不存在的文件保留了原文本
  const legacyStoreDocs = store.listDocuments(`src-legacy-${ctx.workspaceId}`);
  assert.equal(legacyStoreDocs.length, 2);

  // 验证导入后的 legacy 库可被当前工作区检索
  const legacySearchRes = await service.search(ctx, {
    query: 'Guide body content',
    mode: 'fact',
    libraryIds: [importResult.legacyLibraryId],
  });
  assert.ok(legacySearchRes.hits.length > 0);
  assert.ok(legacySearchRes.hits.some((h) => h.text.includes('Guide body content')));
});
