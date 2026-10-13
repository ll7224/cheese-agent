import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledgeTestEnv } from './helpers/knowledge-fixture.js';
import { KnowledgeService } from '../src/knowledge/service.js';
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
