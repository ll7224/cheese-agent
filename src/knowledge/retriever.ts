import type { KnowledgeStore } from './store.js';
import type {
  KnowledgeContext,
  SearchRequest,
  SearchResponse,
  CitationView,
  Citation,
  KnowledgeHit,
  KnowledgeStatus,
  QueryMode,
} from './types.js';
import { resolveLibraries, resolveIndexKeys, getAgentLibraryIds } from './libraries.js';
import { chunkWithSpans } from './chunks.js';
import { indexCode } from './code-indexer.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type QueryEmbedder = (texts: string[]) => Promise<number[][]>;

/**
 * 执行范围受限的混合知识检索。
 * 遵循只在当前已授权的库分区内检索、支持 fact 与 experience 模式、并输出可溯源的 Citation。
 */
export async function executeSearch(
  store: KnowledgeStore,
  ctx: KnowledgeContext,
  request: SearchRequest,
  embedder?: QueryEmbedder
): Promise<SearchResponse> {
  const allLibraries = store.listLibraries();
  const boundLibIds = getAgentLibraryIds(store.db, ctx.agentId);

  // 解析当前上下文真正可访问的知识库清单
  const allowedLibraryIds = resolveLibraries(
    allLibraries,
    ctx,
    boundLibIds,
    request.query,
    request.libraryIds
  );

  if (allowedLibraryIds.length === 0) {
    return {
      generation: store.getGeneration(),
      libraryIds: [],
      hits: [],
      warnings: ['当前上下文无权访问指定或任何知识库'],
    };
  }

  // 区分事实模式与经验模式的状态分区
  const statuses: KnowledgeStatus[] =
    request.mode === 'experience'
      ? ['effective', 'candidate']
      : ['effective'];

  const collectionIds = resolveIndexKeys(allowedLibraryIds, statuses);

  // 在 SQLite 读事务前准备查询向量（若配置了 embedding）
  let queryVector: number[] | undefined;
  if (embedder && request.query.trim().length > 0) {
    try {
      const vectors = await embedder([request.query]);
      queryVector = vectors[0];
    } catch {
      queryVector = undefined;
    }
  }

  // 同步执行快照查询
  return store.readSnapshot((generation) => {
    const rawResults = store.vectorStore.searchPrepared(
      request.query,
      queryVector,
      request.topK || 5,
      collectionIds
    );

    const hits: KnowledgeHit[] = [];

    const stmt = store.db.prepare(`
      SELECT
        r.id AS ref_id,
        r.document_id,
        r.revision_id,
        r.start_offset,
        r.end_offset,
        r.start_line,
        r.end_line,
        r.evidence_kind,
        d.source_id,
        d.source_key,
        d.active_revision_id,
        d.status AS doc_status,
        s.library_id,
        rev.hash,
        rev.commit_hash
      FROM chunk_refs r
      JOIN documents d ON d.id = r.document_id
      JOIN sources s ON s.id = d.source_id
      JOIN revisions rev ON rev.id = r.revision_id
      WHERE r.chunk_id = ?
    `);

    for (const res of rawResults) {
      const meta = stmt.get(res.chunk.id) as any;
      if (!meta) continue;

      // 验证检索结果所属的 libraryId 是否在当前授权列表中
      if (!allowedLibraryIds.includes(meta.library_id)) continue;

      const citation: Citation = {
        id: meta.ref_id,
        documentId: meta.document_id,
        revisionId: meta.revision_id,
        sourceUri: meta.source_key,
        span: {
          startOffset: meta.start_offset,
          endOffset: meta.end_offset,
          startLine: meta.start_line,
          endLine: meta.end_line,
        },
        hash: meta.hash,
        commit: meta.commit_hash || undefined,
        status: (meta.doc_status as KnowledgeStatus) || 'effective',
        evidenceKind: meta.evidence_kind || 'document',
        libraryId: meta.library_id,
      };

      hits.push({
        text: res.chunk.text,
        score: res.score,
        citation,
      });
    }

    return {
      generation,
      libraryIds: allowedLibraryIds,
      hits,
      warnings: [],
    };
  });
}

/**
 * 读取单条引用的完整原文版本与当前有效性视图。
 * 严格执行 Library 范围权限检查，防止跨租户越界。
 */
export function getCitationView(
  store: KnowledgeStore,
  ctx: KnowledgeContext,
  citationId: string
): CitationView {
  const allLibraries = store.listLibraries();
  const boundLibIds = getAgentLibraryIds(store.db, ctx.agentId);
  const allowedLibraryIds = resolveLibraries(allLibraries, ctx, boundLibIds);

  const row = store.db.prepare(`
    SELECT
      r.id AS ref_id,
      r.document_id,
      r.revision_id,
      r.start_offset,
      r.end_offset,
      r.start_line,
      r.end_line,
      r.evidence_kind,
      d.source_id,
      d.source_key,
      d.active_revision_id,
      d.status AS doc_status,
      s.library_id,
      rev.content,
      rev.hash,
      rev.commit_hash
    FROM chunk_refs r
    JOIN documents d ON d.id = r.document_id
    JOIN sources s ON s.id = d.source_id
    JOIN revisions rev ON rev.id = r.revision_id
    WHERE r.id = ? OR r.chunk_id = ?
  `).get(citationId, citationId) as any;

  if (!row) {
    throw new Error(`Citation not found: ${citationId}`);
  }

  // 严格隔离检查：不属于可访问库则报错 403/未找到
  if (!allowedLibraryIds.includes(row.library_id)) {
    throw new Error(`Citation access denied: ${citationId}`);
  }

  const citation: Citation = {
    id: row.ref_id,
    documentId: row.document_id,
    revisionId: row.revision_id,
    sourceUri: row.source_key,
    span: {
      startOffset: row.start_offset,
      endOffset: row.end_offset,
      startLine: row.start_line,
      endLine: row.end_line,
    },
    hash: row.hash,
    commit: row.commit_hash || undefined,
    status: (row.doc_status as KnowledgeStatus) || 'effective',
    evidenceKind: row.evidence_kind || 'document',
    libraryId: row.library_id,
  };

  const isCurrent = Boolean(
    row.active_revision_id && row.revision_id === row.active_revision_id
  );

  return {
    citation,
    content: row.content,
    currentRevisionId: row.active_revision_id || undefined,
    current: isCurrent,
  };
}

/**
 * 受控文档摄入（仅允许向本工作区专属项目库写入受管文档，不授权改写公共基础库）
 */
export async function executeIngest(
  store: KnowledgeStore,
  ctx: KnowledgeContext,
  input: { path?: string; content?: string; name?: string; libraryId: string },
  embedder?: QueryEmbedder
): Promise<{ documentId: string; revisionId: string }> {
  const targetProjectLibId = `project:${ctx.workspaceId}`;
  if (input.libraryId !== targetProjectLibId) {
    throw new Error(`Forbidden: Agents can only ingest into their own project library (${targetProjectLibId})`);
  }

  if (ctx.role === 'guest') {
    throw new Error('Forbidden: Guest users cannot ingest documents');
  }

  let content = input.content;
  if (!content && input.path) {
    const fullPath = path.isAbsolute(input.path) ? input.path : path.join(ctx.workspacePath, input.path);
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch (e: any) {
      throw new Error(`无法读取文件: ${e.message}`);
    }
  }

  if (!content) {
    throw new Error('Ingest content is required');
  }

  if (Buffer.byteLength(content, 'utf-8') > 1024 * 1024) {
    throw new Error('文档内容超过 1 MiB 上限');
  }

  const sourceKey = input.name || input.path || `doc-${Date.now()}`;
  const sourceId = `src-managed-${ctx.workspaceId}`;

  let source = store.getSource(sourceId);
  if (!source) {
    source = store.createSource({
      id: sourceId,
      libraryId: input.libraryId,
      kind: 'managed',
      locator: 'managed',
      enabled: true,
    });
  }

  const rawChunks = chunkWithSpans(content);
  let chunkEmbeddings: number[][] | undefined;
  if (embedder && rawChunks.length > 0) {
    try {
      chunkEmbeddings = await embedder(rawChunks.map((c) => c.text));
    } catch {}
  }

  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const existingDoc = store.getDocument(sourceId, sourceKey);

  let codeIndex: any = undefined;
  const ext = path.extname(sourceKey).toLowerCase();
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    codeIndex = indexCode(ctx.workspaceId, sourceKey, content, ctx.workspacePath);
  }

  return store.publishRevision({
    sourceId: source.id,
    sourceKey,
    content,
    hash,
    expectedPreviousRevisionId: existingDoc?.activeRevisionId || null,
    chunks: rawChunks.map((c, idx) => ({
      text: c.text,
      span: c.span,
      embedding: chunkEmbeddings ? chunkEmbeddings[idx] : undefined,
      evidenceKind: codeIndex ? 'code' : 'document',
    })),
    codeIndex,
  });
}
