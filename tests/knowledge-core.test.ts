import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createKnowledgeTestEnv, seedDocument } from './helpers/knowledge-fixture.js';
import { chunkWithSpans } from '../src/knowledge/chunks.js';
import { KnowledgeService } from '../src/knowledge/service.js';
import type { KnowledgeContext } from '../src/knowledge/types.js';

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
