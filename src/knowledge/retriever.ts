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
import { resolveLibraries, resolveIndexKeys, getAgentLibraryIds, getWorkspaceLibraryIds } from './libraries.js';
import { chunkWithSpans } from './chunks.js';
import { indexCode } from './code-indexer.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type QueryEmbedder = (texts: string[]) => Promise<number[][]>;

export function emptySearchResponse(generation: number = 1): SearchResponse {
  return {
    generation,
    libraryIds: [],
    hits: [],
    warnings: [],
  };
}

/**
 * 在受控范围内执行混合向量/全文检索，返回种子候选
 */
export function searchPreparedWithinScope(
  store: KnowledgeStore,
  request: SearchRequest,
  queryVector: number[] | undefined,
  allowedLibraryIds: string[]
): KnowledgeHit[] {
  const statuses: KnowledgeStatus[] =
    request.mode === 'experience'
      ? ['effective', 'candidate']
      : ['effective'];

  const collectionIds = resolveIndexKeys(allowedLibraryIds, statuses);
  if (collectionIds.length === 0) return [];

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

  const itemStmt = store.db.prepare(`
    SELECT * FROM knowledge_items
    WHERE id = ?
       OR id = ?
       OR id = REPLACE(?, 'item-chunk-', '')
       OR id = REPLACE(?, 'chunk-', '')
       OR ('knowledge-item:' || id) = ?
       OR text = ?
  `);

  for (const res of rawResults) {
    const meta = stmt.get(res.chunk.id) as any;
    if (meta) {
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
      continue;
    }

    const itemRow = itemStmt.get(
      res.chunk.id,
      res.chunk.source,
      res.chunk.id,
      res.chunk.id,
      res.chunk.source,
      res.chunk.text
    ) as any;

    if (itemRow) {
      if (!allowedLibraryIds.includes(itemRow.library_id)) continue;
      if (request.mode === 'fact' && itemRow.status === 'candidate') continue;
      if (itemRow.status === 'invalidated' || itemRow.status === 'needs_review') continue;

      let evidenceKind: any = 'document';
      if (itemRow.kind === 'decision') evidenceKind = 'decision';
      else if (itemRow.kind === 'observation') evidenceKind = 'observation';

      const lines = (itemRow.text || '').split('\n');
      const citation: Citation = {
        id: `ref-${itemRow.id}`,
        documentId: itemRow.id,
        revisionId: `rev-${itemRow.id}`,
        sourceUri: `knowledge-item:${itemRow.kind}`,
        span: {
          startOffset: 0,
          endOffset: itemRow.text.length,
          startLine: 1,
          endLine: lines.length,
        },
        hash: crypto.createHash('sha256').update(itemRow.text).digest('hex'),
        commit: undefined,
        status: itemRow.status as KnowledgeStatus,
        evidenceKind,
        libraryId: itemRow.library_id,
      };

      hits.push({
        text: res.chunk.text,
        score: res.score,
        citation,
      });
    }
  }

  return hits;
}

/**
 * 沿图谱关系扩展邻接证据：
 * 文本/符号召回前 5 个种子，最多沿有效 contains/imports/exports 2 跳；effective explains/constrains 可补充证据。
 * experience 模式才可沿候选语义边，并保留候选标签。图扩展最多增加 10 个片段。
 */
export function graphEvidenceWithinScope(
  store: KnowledgeStore,
  seeds: KnowledgeHit[],
  allowedLibraryIds: string[],
  mode: QueryMode,
  maxHops: number = 2,
  maxAdditionalChunks: number = 10
): KnowledgeHit[] {
  if (seeds.length === 0 || allowedLibraryIds.length === 0) return [];

  const topSeeds = seeds.slice(0, 5);
  const inClause = allowedLibraryIds.map(() => '?').join(',');

  const startNodeIds = new Set<string>();

  for (const s of topSeeds) {
    const c = s.citation;
    if (c.documentId.startsWith('item-') || c.sourceUri.startsWith('knowledge-item:')) {
      startNodeIds.add(c.documentId);
    }

    const entRows = store.db.prepare(`
      SELECT id FROM entities
      WHERE (path = ? OR revision_id = ?)
        AND library_id IN (${inClause})
    `).all(c.sourceUri, c.revisionId, ...allowedLibraryIds) as Array<{ id: string }>;
    for (const er of entRows) {
      startNodeIds.add(er.id);
    }

    const edgeEndpoints = store.db.prepare(`
      SELECT source_id, target_id FROM edges
      WHERE (source_id = ? OR target_id = ?)
        AND library_id IN (${inClause})
    `).all(c.documentId, c.documentId, ...allowedLibraryIds) as Array<{ source_id: string; target_id: string }>;
    for (const ee of edgeEndpoints) {
      startNodeIds.add(ee.source_id);
      startNodeIds.add(ee.target_id);
    }
  }

  if (startNodeIds.size === 0) return [];

  const visitedNodes = new Set<string>(startNodeIds);
  let frontier = Array.from(startNodeIds);
  const reachedNodeInfo = new Map<string, { status: KnowledgeStatus; edgeKind: string }>();

  const allowedStructuralKinds = new Set(['contains', 'imports', 'exports']);
  const allowedSemanticKinds = new Set(['explains', 'constrains', 'supersedes']);

  for (let hop = 0; hop < maxHops; hop++) {
    if (frontier.length === 0) break;
    const nextFrontier: string[] = [];

    for (const currId of frontier) {
      const edges = store.db.prepare(`
        SELECT * FROM edges
        WHERE (source_id = ? OR target_id = ?)
          AND library_id IN (${inClause})
      `).all(currId, currId, ...allowedLibraryIds) as any[];

      for (const e of edges) {
        if (e.status === 'invalidated' || e.status === 'needs_review') continue;

        const isStructural = allowedStructuralKinds.has(e.kind);
        const isSemantic = allowedSemanticKinds.has(e.kind);
        if (!isStructural && !isSemantic) continue;

        if (isStructural && e.status !== 'effective') continue;

        if (isSemantic) {
          if (mode === 'fact' && e.status !== 'effective') continue;
          if (mode === 'experience' && e.status !== 'effective' && e.status !== 'candidate') continue;
        }

        const neighborId = e.source_id === currId ? e.target_id : e.source_id;
        if (!visitedNodes.has(neighborId)) {
          visitedNodes.add(neighborId);
          reachedNodeInfo.set(neighborId, {
            status: e.status as KnowledgeStatus,
            edgeKind: e.kind,
          });
          nextFrontier.push(neighborId);
        }
      }
    }

    frontier = nextFrontier;
  }

  const additionalHits: KnowledgeHit[] = [];
  const seedDocIds = new Set(topSeeds.map((s) => s.citation.documentId));

  for (const [nodeId, info] of reachedNodeInfo.entries()) {
    if (additionalHits.length >= maxAdditionalChunks) break;
    if (seedDocIds.has(nodeId)) continue;

    // 1. 检查是否为知识条目
    const item = store.getKnowledgeItem(nodeId);
    if (item && allowedLibraryIds.includes(item.libraryId)) {
      if (item.status === 'invalidated' || item.status === 'needs_review') continue;
      if (mode === 'fact' && item.status === 'candidate') continue;

      const hitStatus = (info.status === 'candidate' || item.status === 'candidate')
        ? 'candidate'
        : 'effective';

      let evidenceKind: any = 'document';
      if (item.kind === 'decision') evidenceKind = 'decision';
      else if (item.kind === 'observation') evidenceKind = 'observation';

      const lines = item.text.split('\n');
      additionalHits.push({
        text: item.text,
        score: 0.85,
        citation: {
          id: `ref-${item.id}`,
          documentId: item.id,
          revisionId: `rev-${item.id}`,
          sourceUri: `knowledge-item:${item.kind}`,
          span: {
            startOffset: 0,
            endOffset: item.text.length,
            startLine: 1,
            endLine: lines.length,
          },
          hash: crypto.createHash('sha256').update(item.text).digest('hex'),
          status: hitStatus,
          evidenceKind,
          libraryId: item.libraryId,
        },
      });
      continue;
    }

    // 2. 检查是否为代码实体
    const ent = store.db.prepare(`
      SELECT * FROM entities
      WHERE id = ? AND library_id IN (${inClause})
    `).get(nodeId, ...allowedLibraryIds) as any;

    if (ent) {
      const rev = store.readRevision(ent.revision_id);
      let snippet = `// [code entity] ${ent.kind} ${ent.name}\n// ${ent.path}:${ent.start_line}-${ent.end_line}`;
      if (rev) {
        const fileLines = rev.content.split('\n');
        snippet = fileLines.slice(ent.start_line - 1, ent.end_line).join('\n') || snippet;
      }

      additionalHits.push({
        text: snippet,
        score: 0.8,
        citation: {
          id: `ref-entity-${ent.id}`,
          documentId: ent.id,
          revisionId: ent.revision_id,
          sourceUri: ent.path,
          span: {
            startOffset: ent.start_offset,
            endOffset: ent.end_offset,
            startLine: ent.start_line,
            endLine: ent.end_line,
          },
          hash: rev ? rev.hash : '',
          status: info.status,
          evidenceKind: 'code',
          libraryId: ent.library_id,
        },
      });
      continue;
    }

    // 3. 检查是否为文档
    const doc = store.getDocumentById(nodeId);
    if (doc && doc.activeRevisionId) {
      const rev = store.readRevision(doc.activeRevisionId);
      if (rev) {
        const lines = rev.content.split('\n');
        additionalHits.push({
          text: rev.content.slice(0, 500),
          score: 0.75,
          citation: {
            id: `ref-doc-${doc.id}`,
            documentId: doc.id,
            revisionId: doc.activeRevisionId,
            sourceUri: doc.sourceKey,
            span: {
              startOffset: 0,
              endOffset: Math.min(rev.content.length, 500),
              startLine: 1,
              endLine: Math.min(lines.length, 25),
            },
            hash: rev.hash,
            status: info.status,
            evidenceKind: 'document',
            libraryId: allowedLibraryIds[0] as string,
          },
        });
      }
    }
  }

  return additionalHits;
}

/**
 * 合并去重并截断检索结果
 */
export function buildSearchResponse(
  generation: number,
  allowedLibraryIds: string[],
  seeds: KnowledgeHit[],
  related: KnowledgeHit[],
  topK: number = 20
): SearchResponse {
  const seenDocIds = new Set<string>();
  const combined: KnowledgeHit[] = [];

  for (const s of seeds) {
    const key = `${s.citation.documentId}:${s.citation.span.startLine}:${s.citation.span.endLine}`;
    if (!seenDocIds.has(key)) {
      seenDocIds.add(key);
      combined.push(s);
    }
  }

  for (const r of related) {
    const key = `${r.citation.documentId}:${r.citation.span.startLine}:${r.citation.span.endLine}`;
    if (!seenDocIds.has(key)) {
      seenDocIds.add(key);
      combined.push(r);
    }
  }

  const finalHits = combined.slice(0, Math.min(topK, 20));
  return {
    generation,
    libraryIds: allowedLibraryIds,
    hits: finalHits,
    warnings: [],
  };
}

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
  const boundWorkspaceLibIds = getWorkspaceLibraryIds(store.db, ctx.workspaceId);

  // 解析当前上下文真正可访问的知识库清单
  const allowedLibraryIds = resolveLibraries(
    allLibraries,
    ctx,
    boundLibIds,
    request.query,
    request.libraryIds,
    boundWorkspaceLibIds
  );

  if (allowedLibraryIds.length === 0) {
    return emptySearchResponse(store.getGeneration());
  }

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

  // 同步执行快照查询，禁止 await 在 readSnapshot 内部
  return store.readSnapshot((generation) => {
    const seeds = searchPreparedWithinScope(
      store,
      request,
      queryVector,
      allowedLibraryIds
    );

    const related = request.includeGraph
      ? graphEvidenceWithinScope(
          store,
          seeds,
          allowedLibraryIds,
          request.mode,
          2,
          10
        )
      : [];

    const effectiveTopK = Math.min(Math.max(request.topK || 5, 1), 20);
    return buildSearchResponse(
      generation,
      allowedLibraryIds,
      seeds,
      related,
      request.includeGraph ? Math.min(effectiveTopK + related.length, 20) : effectiveTopK
    );
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
  const boundWorkspaceLibIds = getWorkspaceLibraryIds(store.db, ctx.workspaceId);
  const allowedLibraryIds = resolveLibraries(
    allLibraries,
    ctx,
    boundLibIds,
    undefined,
    undefined,
    boundWorkspaceLibIds
  );

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
    const cleanedId = citationId.replace(/^ref-/, '').replace(/^item-chunk-/, '');
    const itemRow = store.db.prepare(`
      SELECT * FROM knowledge_items WHERE id = ? OR ('ref-' || id) = ?
    `).get(cleanedId, citationId) as any;

    if (itemRow) {
      if (!allowedLibraryIds.includes(itemRow.library_id)) {
        throw new Error(`Citation access denied: ${citationId}`);
      }
      let evidenceKind: any = 'document';
      if (itemRow.kind === 'decision') evidenceKind = 'decision';
      else if (itemRow.kind === 'observation') evidenceKind = 'observation';

      const lines = (itemRow.text || '').split('\n');
      const citation: Citation = {
        id: citationId,
        documentId: itemRow.id,
        revisionId: `rev-${itemRow.id}`,
        sourceUri: `knowledge-item:${itemRow.kind}`,
        span: {
          startOffset: 0,
          endOffset: itemRow.text.length,
          startLine: 1,
          endLine: lines.length,
        },
        hash: crypto.createHash('sha256').update(itemRow.text).digest('hex'),
        commit: undefined,
        status: itemRow.status as KnowledgeStatus,
        evidenceKind,
        libraryId: itemRow.library_id,
      };

      const isCurrent = itemRow.status === 'effective';
      return {
        citation,
        content: itemRow.text,
        currentRevisionId: isCurrent ? `rev-${itemRow.id}` : undefined,
        current: isCurrent,
      };
    }

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
