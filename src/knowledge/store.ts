import Database from 'better-sqlite3';
import { SqliteVectorStore } from '../rag/sqlite-store.js';
import { initKnowledgeSchema } from './schema.js';
import type {
  Library,
  Source,
  RevisionDraft,
  SourceSpan,
} from './types.js';

/**
 * 统一持有知识中心 SQLite 连接、元数据事务与混合向量存储的底层存储中枢。
 */
export class KnowledgeStore {
  readonly db: Database.Database;
  readonly vectorStore: SqliteVectorStore;
  private ownsDb: boolean = false;

  constructor(dbOrPath: string | Database.Database) {
    if (typeof dbOrPath === 'string') {
      this.db = new Database(dbOrPath);
      this.ownsDb = true;
    } else {
      this.db = dbOrPath;
      this.ownsDb = false;
    }

    // 初始化 schema
    initKnowledgeSchema(this.db);
    // 注入连接给向量库，确保两者在同一连接与事务空间内操作
    this.vectorStore = new SqliteVectorStore(this.db);
  }

  /**
   * 创建知识库记录
   */
  createLibrary(input: Library): Library {
    const createdAt = input.createdAt || Date.now();
    this.db.prepare(`
      INSERT OR REPLACE INTO libraries (id, name, description, scope, workspace_id, role, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.name,
      input.description,
      input.scope,
      input.workspaceId || null,
      input.role,
      createdAt
    );

    // 若该知识库此前曾被删除，重新创建时清除墓碑标记
    this.db.prepare(`DELETE FROM deleted_libraries WHERE id = ?`).run(input.id);

    if (input.workspaceId) {
      this.db.prepare(`
        INSERT OR IGNORE INTO workspace_bindings (workspace_id, library_id) VALUES (?, ?)
      `).run(input.workspaceId, input.id);
    }
    if (input.workspaceIds) {
      for (const wsId of input.workspaceIds) {
        if (wsId && wsId.trim()) {
          this.db.prepare(`
            INSERT OR IGNORE INTO workspace_bindings (workspace_id, library_id) VALUES (?, ?)
          `).run(wsId.trim(), input.id);
        }
      }
    }

    return { ...input, createdAt };
  }

  /**
   * 检查知识库是否已被显式删除（处于墓碑状态）
   */
  isLibraryDeleted(id: string): boolean {
    const row = this.db.prepare(`SELECT id FROM deleted_libraries WHERE id = ?`).get(id);
    return Boolean(row);
  }

  /**
   * 彻底删除知识库及下属所有来源、文档、版本、分块向量/全文索引、图谱与沉淀。
   * 记录已删除墓碑以避免初始化逻辑自动复活。
   */
  deleteLibrary(id: string): boolean {
    const lib = this.getLibrary(id);
    if (!lib) return false;

    const tx = this.db.transaction(() => {
      // 1. 获取该知识库下属的所有来源并清理文档、版本、分块索引
      this.db.exec(`
        CREATE TEMP TABLE IF NOT EXISTS _tmp_del_docs (id TEXT PRIMARY KEY);
        DELETE FROM _tmp_del_docs;
      `);
      this.db.prepare(`
        INSERT OR IGNORE INTO _tmp_del_docs (id)
        SELECT d.id FROM documents d
        JOIN sources s ON d.source_id = s.id
        WHERE s.library_id = ?
      `).run(id);

      const chunkRows = this.db.prepare(`
        SELECT chunk_id FROM chunk_refs WHERE document_id IN (SELECT id FROM _tmp_del_docs)
      `).all() as Array<{ chunk_id: string }>;
      const chunkIds = chunkRows.map((c) => c.chunk_id);
      this.vectorStore.removeChunks(chunkIds);

      this.db.exec(`
        DELETE FROM chunk_refs WHERE document_id IN (SELECT id FROM _tmp_del_docs);
        DELETE FROM revisions WHERE document_id IN (SELECT id FROM _tmp_del_docs);
        DELETE FROM documents WHERE id IN (SELECT id FROM _tmp_del_docs);
        DELETE FROM _tmp_del_docs;
      `);

      this.db.prepare(`DELETE FROM sources WHERE library_id = ?`).run(id);

      // 2. 清理沉淀条目及向量
      const items = this.db.prepare(`SELECT id FROM knowledge_items WHERE library_id = ?`).all(id) as Array<{ id: string }>;
      for (const it of items) {
        this.vectorStore.removeChunks([`item:${it.id}`]);
      }
      this.db.prepare(`DELETE FROM knowledge_items WHERE library_id = ?`).run(id);

      // 3. 清理该知识库在 chunks/vec/fts 中基于 collection_id 维度的所有切片
      this.vectorStore.removeChunksByCollection(id);

      // 4. 清理图谱实体与边
      this.db.prepare(`DELETE FROM entities WHERE library_id = ?`).run(id);
      this.db.prepare(`
        DELETE FROM edge_evidence WHERE edge_id IN (SELECT id FROM edges WHERE library_id = ?)
      `).run(id);
      this.db.prepare(`DELETE FROM edges WHERE library_id = ?`).run(id);

      // 5. 清理绑定关联
      this.db.prepare(`DELETE FROM workspace_bindings WHERE library_id = ?`).run(id);
      this.db.prepare(`DELETE FROM bindings WHERE library_id = ?`).run(id);

      // 6. 清理知识库本体
      this.db.prepare(`DELETE FROM libraries WHERE id = ?`).run(id);

      // 7. 写入已删除墓碑记录，防止再次被 attachWorkspace 自动创建
      this.db.prepare(`INSERT OR REPLACE INTO deleted_libraries (id, deleted_at) VALUES (?, ?)`).run(id, Date.now());

      // 8. 递增全局 generation
      this.db.prepare(`UPDATE generation SET version = version + 1 WHERE id = 1`).run();
    });

    tx();
    return true;
  }

  /**
   * 查询指定知识库
   */
  getLibrary(id: string): Library | null {
    const row = this.db.prepare(`SELECT * FROM libraries WHERE id = ?`).get(id) as any;
    if (!row) return null;

    const wsRows = this.db.prepare(`SELECT workspace_id FROM workspace_bindings WHERE library_id = ?`).all(id) as Array<{ workspace_id: string }>;
    const workspaceIds = wsRows.map((r) => r.workspace_id);
    if (row.workspace_id && !workspaceIds.includes(row.workspace_id)) {
      workspaceIds.push(row.workspace_id);
    }

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      scope: row.scope,
      workspaceId: row.workspace_id || undefined,
      workspaceIds,
      role: row.role,
      createdAt: row.created_at,
    };
  }

  /**
   * 列出所有知识库（可按工作区筛选）
   */
  listLibraries(workspaceId?: string): Library[] {
    let rows: any[];
    if (workspaceId) {
      rows = this.db.prepare(`
        SELECT DISTINCT l.* FROM libraries l
        LEFT JOIN workspace_bindings wb ON l.id = wb.library_id
        WHERE l.workspace_id = ? OR wb.workspace_id = ? OR l.scope = 'public'
        ORDER BY l.created_at ASC
      `).all(workspaceId, workspaceId);
    } else {
      rows = this.db.prepare(`SELECT * FROM libraries ORDER BY created_at ASC`).all();
    }

    const wsMap = new Map<string, string[]>();
    const allBindings = this.db.prepare(`SELECT workspace_id, library_id FROM workspace_bindings`).all() as Array<{ workspace_id: string; library_id: string }>;
    for (const b of allBindings) {
      const arr = wsMap.get(b.library_id) || [];
      arr.push(b.workspace_id);
      wsMap.set(b.library_id, arr);
    }

    return rows.map((row) => {
      const boundWs = wsMap.get(row.id) || [];
      if (row.workspace_id && !boundWs.includes(row.workspace_id)) {
        boundWs.push(row.workspace_id);
      }
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        scope: row.scope,
        workspaceId: row.workspace_id || undefined,
        workspaceIds: boundWs,
        role: row.role,
        createdAt: row.created_at,
      };
    });
  }

  /**
   * 创建来源记录
   */
  createSource(input: Source): Source {
    const createdAt = input.createdAt || Date.now();
    this.db.prepare(`
      INSERT OR REPLACE INTO sources
        (id, library_id, kind, locator, enabled, version_constraint, sync_status, last_sync_at, last_error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.libraryId,
      input.kind,
      input.locator,
      input.enabled ? 1 : 0,
      input.versionConstraint || null,
      input.syncStatus || 'ready',
      input.lastSyncAt || null,
      input.lastError || null,
      createdAt
    );
    return { ...input, createdAt };
  }

  /**
   * 查询指定来源
   */
  getSource(id: string): Source | null {
    const row = this.db.prepare(`SELECT * FROM sources WHERE id = ?`).get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      libraryId: row.library_id,
      kind: row.kind,
      locator: row.locator,
      enabled: Boolean(row.enabled),
      versionConstraint: row.version_constraint || undefined,
      syncStatus: row.sync_status,
      lastSyncAt: row.last_sync_at || undefined,
      lastError: row.last_error || undefined,
      createdAt: row.created_at,
    };
  }

  /**
   * 列出来源列表
   */
  listSources(libraryId?: string): Source[] {
    let rows: any[];
    if (libraryId) {
      rows = this.db.prepare(`SELECT * FROM sources WHERE library_id = ? ORDER BY created_at ASC`).all(libraryId);
    } else {
      rows = this.db.prepare(`SELECT * FROM sources ORDER BY created_at ASC`).all();
    }
    return rows.map((row) => ({
      id: row.id,
      libraryId: row.library_id,
      kind: row.kind,
      locator: row.locator,
      enabled: Boolean(row.enabled),
      versionConstraint: row.version_constraint || undefined,
      syncStatus: row.sync_status,
      lastSyncAt: row.last_sync_at || undefined,
      lastError: row.last_error || undefined,
      createdAt: row.created_at,
    }));
  }

  /**
   * 更新来源属性
   */
  updateSource(id: string, updates: Partial<Source>): Source {
    const current = this.getSource(id);
    if (!current) throw new Error(`Source not found: ${id}`);
    const next: Source = { ...current, ...updates };
    this.db.prepare(`
      UPDATE sources SET
        library_id = ?, kind = ?, locator = ?, enabled = ?,
        version_constraint = ?, sync_status = ?, last_sync_at = ?, last_error = ?
      WHERE id = ?
    `).run(
      next.libraryId,
      next.kind,
      next.locator,
      next.enabled ? 1 : 0,
      next.versionConstraint || null,
      next.syncStatus || 'ready',
      next.lastSyncAt || null,
      next.lastError || null,
      id
    );
    return next;
  }

  /**
   * 获取或初始化文档身份
   */
  private getOrCreateDocument(sourceId: string, sourceKey: string): { id: string; activeRevisionId: string | null } {
    const existing = this.db.prepare(`
      SELECT id, active_revision_id FROM documents WHERE source_id = ? AND source_key = ?
    `).get(sourceId, sourceKey) as any;

    if (existing) {
      return { id: existing.id, activeRevisionId: existing.active_revision_id };
    }

    const docId = `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO documents (id, source_id, source_key, active_revision_id, status, created_at, updated_at)
      VALUES (?, ?, ?, NULL, 'effective', ?, ?)
    `).run(docId, sourceId, sourceKey, now, now);

    return { id: docId, activeRevisionId: null };
  }

  /**
   * 根据 sourceId 与 sourceKey 查询文档
   */
  getDocument(sourceId: string, sourceKey: string): { id: string; activeRevisionId: string | null; status: string } | null {
    const normalizedSourceKey = sourceKey.trim().replace(/\\/g, '/');
    const existing = this.db.prepare(`
      SELECT id, active_revision_id, status FROM documents WHERE source_id = ? AND source_key = ?
    `).get(sourceId, normalizedSourceKey) as any;
    if (!existing) return null;
    return { id: existing.id, activeRevisionId: existing.active_revision_id, status: existing.status };
  }

  /**
   * 列出指定 sourceId 下的所有文档
   */
  listDocuments(sourceId: string): Array<{ id: string; sourceKey: string; activeRevisionId: string | null; status: string }> {
    const rows = this.db.prepare(`
      SELECT id, source_key, active_revision_id, status FROM documents WHERE source_id = ?
    `).all(sourceId) as any[];
    return rows.map((r) => ({
      id: r.id,
      sourceKey: r.source_key,
      activeRevisionId: r.active_revision_id,
      status: r.status,
    }));
  }

  /**
   * 原子发布文档新版本。
   * 采用显式 CAS 校验上一版本，清理旧索引，写入新不可变 Revision，
   * 写入新分块及 FTS/向量索引，并递增全局 generation。
   */
  publishRevision(input: RevisionDraft): { documentId: string; revisionId: string } {
    const source = this.getSource(input.sourceId);
    if (!source) throw new Error(`Source not found: ${input.sourceId}`);

    const normalizedSourceKey = input.sourceKey.trim().replace(/\\/g, '/');

    const tx = this.db.transaction(() => {
      const doc = this.getOrCreateDocument(input.sourceId, normalizedSourceKey);
      const documentId = doc.id;

      // 1. CAS 校验
      if (input.expectedPreviousRevisionId !== undefined) {
        if (doc.activeRevisionId !== input.expectedPreviousRevisionId) {
          throw new Error(
            `CAS conflict for document ${documentId}: expected previous ${input.expectedPreviousRevisionId}, actual ${doc.activeRevisionId}`
          );
        }
      }

      const revisionId = `rev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const now = Date.now();

      // 2. 获取并清理旧 chunk
      const prevChunkRows = this.db.prepare(`
        SELECT chunk_id FROM chunk_refs WHERE document_id = ?
      `).all(documentId) as Array<{ chunk_id: string }>;
      const prevChunkIds = prevChunkRows.map((r) => r.chunk_id);
      this.vectorStore.removeChunks(prevChunkIds);

      // 3. 写入不可变版本
      this.db.prepare(`
        INSERT INTO revisions (id, document_id, content, hash, commit_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(revisionId, documentId, input.content, input.hash, input.commit || null, now);

      // 4. 准备写入新分块
      const collectionId = `${source.libraryId}:effective`;
      const nextChunks: Array<{
        id: string;
        text: string;
        source: string;
        chunkIndex: number;
        collectionId: string;
        embedding?: number[];
      }> = [];

      for (let i = 0; i < input.chunks.length; i++) {
        const c = input.chunks[i];
        const chunkId = `${documentId}:${revisionId}:${i}`;
        nextChunks.push({
          id: chunkId,
          text: c.text,
          source: normalizedSourceKey,
          chunkIndex: i,
          collectionId,
          embedding: c.embedding,
        });
      }

      this.vectorStore.upsertIndexedChunks(nextChunks);

      // 5. 替换 chunk_refs
      this.db.prepare(`DELETE FROM chunk_refs WHERE document_id = ?`).run(documentId);
      const insertRef = this.db.prepare(`
        INSERT INTO chunk_refs (id, document_id, revision_id, chunk_id, start_offset, end_offset, start_line, end_line, evidence_kind)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (let i = 0; i < input.chunks.length; i++) {
        const c = input.chunks[i];
        const chunkId = `${documentId}:${revisionId}:${i}`;
        insertRef.run(
          chunkId,
          documentId,
          revisionId,
          chunkId,
          c.span.startOffset,
          c.span.endOffset,
          c.span.startLine,
          c.span.endLine,
          c.evidenceKind || 'document'
        );
      }

      // 6. 激活当前版本
      this.db.prepare(`
        UPDATE documents SET active_revision_id = ?, updated_at = ? WHERE id = ?
      `).run(revisionId, now, documentId);

      // 6.1 代码结构索引（共用同一事务发布与更新）
      if (input.codeIndex) {
        const libRow = this.db.prepare(`SELECT workspace_id FROM libraries WHERE id = ?`).get(source.libraryId) as any;
        let workspaceId = libRow?.workspace_id || '';
        if (!workspaceId) {
          const wsBindRow = this.db.prepare(`SELECT workspace_id FROM workspace_bindings WHERE library_id = ? LIMIT 1`).get(source.libraryId) as any;
          if (wsBindRow?.workspace_id) {
            workspaceId = wsBindRow.workspace_id;
          }
        }
        this.applyCodeIndexTx(source.libraryId, workspaceId, revisionId, doc.activeRevisionId, input.codeIndex);
      }

      // 7. 递增 generation
      this.db.prepare(`
        UPDATE generation SET version = version + 1 WHERE id = 1
      `).run();

      return { documentId, revisionId };
    });

    return tx();
  }

  /**
   * 在当前事务内应用代码实体与关联边，并清理旧 revision 的证据归属
   */
  private applyCodeIndexTx(
    libraryId: string,
    workspaceId: string,
    revisionId: string,
    oldRevisionId: string | null,
    codeIndex: NonNullable<RevisionDraft['codeIndex']>
  ): void {
    if (oldRevisionId) {
      this.db.prepare(`DELETE FROM edge_evidence WHERE revision_id = ?`).run(oldRevisionId);
      this.db.prepare(`DELETE FROM entities WHERE revision_id = ?`).run(oldRevisionId);
      this.db.prepare(`
        DELETE FROM edges
        WHERE status = 'effective'
          AND id NOT IN (SELECT DISTINCT edge_id FROM edge_evidence)
      `).run();
    }

    const insertEntity = this.db.prepare(`
      INSERT INTO entities (
        id, workspace_id, path, container, kind, name,
        library_id, revision_id, start_offset, end_offset, start_line, end_line
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        path = excluded.path,
        container = excluded.container,
        kind = excluded.kind,
        name = excluded.name,
        library_id = excluded.library_id,
        revision_id = excluded.revision_id,
        start_offset = excluded.start_offset,
        end_offset = excluded.end_offset,
        start_line = excluded.start_line,
        end_line = excluded.end_line
    `);

    for (const ent of codeIndex.entities) {
      insertEntity.run(
        ent.id,
        ent.workspaceId || workspaceId,
        ent.path,
        ent.container || null,
        ent.kind,
        ent.name,
        libraryId,
        revisionId,
        ent.span.startOffset,
        ent.span.endOffset,
        ent.span.startLine,
        ent.span.endLine
      );
    }

    const checkEdge = this.db.prepare(`SELECT status FROM edges WHERE id = ?`);
    const insertEdge = this.db.prepare(`
      INSERT INTO edges (id, source_id, target_id, kind, status, library_id)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source_id = excluded.source_id,
        target_id = excluded.target_id,
        kind = excluded.kind,
        library_id = excluded.library_id
    `);

    const insertEvidence = this.db.prepare(`
      INSERT INTO edge_evidence (id, edge_id, revision_id, start_offset, end_offset, start_line, end_line)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const edge of codeIndex.edges) {
      const existing = checkEdge.get(edge.id) as { status: string } | undefined;
      const status = existing ? existing.status : 'effective';
      insertEdge.run(edge.id, edge.sourceEntityId, edge.targetEntityId, edge.kind, status, libraryId);

      const span = edge.span || { startOffset: 0, endOffset: 0, startLine: 1, endLine: 1 };
      const evidenceId = `evi-${revisionId}-${Math.random().toString(36).slice(2, 8)}`;
      insertEvidence.run(
        evidenceId,
        edge.id,
        revisionId,
        span.startOffset,
        span.endOffset,
        span.startLine,
        span.endLine
      );
    }
  }

  /**
   * 删除文档并将其片段移出检索索引（保留历史版本记录）
   */
  deleteDocument(documentId: string): void {
    const tx = this.db.transaction(() => {
      const docRow = this.db.prepare(`SELECT active_revision_id FROM documents WHERE id = ?`).get(documentId) as any;
      if (docRow?.active_revision_id) {
        this.db.prepare(`DELETE FROM edge_evidence WHERE revision_id = ?`).run(docRow.active_revision_id);
        this.db.prepare(`DELETE FROM entities WHERE revision_id = ?`).run(docRow.active_revision_id);
        this.db.prepare(`
          DELETE FROM edges
          WHERE status = 'effective'
            AND id NOT IN (SELECT DISTINCT edge_id FROM edge_evidence)
        `).run();
      }

      const prevChunkRows = this.db.prepare(`
        SELECT chunk_id FROM chunk_refs WHERE document_id = ?
      `).all(documentId) as Array<{ chunk_id: string }>;
      const prevChunkIds = prevChunkRows.map((r) => r.chunk_id);
      this.vectorStore.removeChunks(prevChunkIds);

      this.db.prepare(`DELETE FROM chunk_refs WHERE document_id = ?`).run(documentId);
      this.db.prepare(`
        UPDATE documents SET active_revision_id = NULL, status = 'deleted', updated_at = ? WHERE id = ?
      `).run(Date.now(), documentId);

      this.db.prepare(`UPDATE generation SET version = version + 1 WHERE id = 1`).run();
    });
    tx();
  }

  /**
   * 读取不可变版本的原文内容与 hash
   */
  readRevision(revisionId: string): { content: string; hash: string } | null {
    const row = this.db.prepare(`
      SELECT content, hash FROM revisions WHERE id = ?
    `).get(revisionId) as any;
    if (!row) return null;
    return { content: row.content, hash: row.hash };
  }

  /**
   * 获取当前生效版本的片段及其真实原文跨度（span）
   */
  currentChunks(documentId: string): Array<{ id: string; text: string; span: SourceSpan }> {
    const rows = this.db.prepare(`
      SELECT r.chunk_id, r.start_offset, r.end_offset, r.start_line, r.end_line, c.text
      FROM chunk_refs r
      JOIN chunks c ON c.id = r.chunk_id
      WHERE r.document_id = ?
      ORDER BY r.start_offset ASC
    `).all(documentId) as any[];

    return rows.map((r) => ({
      id: r.chunk_id,
      text: r.text,
      span: {
        startOffset: r.start_offset,
        endOffset: r.end_offset,
        startLine: r.start_line,
        endLine: r.end_line,
      },
    }));
  }

  /**
   * 获取全局当前 generation
   */
  getGeneration(): number {
    const row = this.db.prepare(`SELECT version FROM generation WHERE id = 1`).get() as any;
    return row ? row.version : 1;
  }

  /**
   * 同步读取快照执行回调
   */
  readSnapshot<T>(fn: (generation: number) => T): T {
    const gen = this.getGeneration();
    return fn(gen);
  }

  /**
   * 根据 ID 查询文档详情
   */
  getDocumentById(documentId: string): {
    id: string;
    sourceId: string;
    sourceKey: string;
    activeRevisionId: string | null;
    status: string;
    createdAt: number;
    updatedAt: number;
  } | null {
    const row = this.db.prepare(`SELECT * FROM documents WHERE id = ?`).get(documentId) as any;
    if (!row) return null;
    return {
      id: row.id,
      sourceId: row.source_id,
      sourceKey: row.source_key,
      activeRevisionId: row.active_revision_id,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * 列出文档的历史版本列表
   */
  listRevisions(documentId: string): Array<{
    id: string;
    documentId: string;
    hash: string;
    commitHash?: string;
    createdAt: number;
  }> {
    const rows = this.db.prepare(`
      SELECT id, document_id, hash, commit_hash, created_at
      FROM revisions
      WHERE document_id = ?
      ORDER BY created_at DESC
    `).all(documentId) as any[];
    return rows.map((r) => ({
      id: r.id,
      documentId: r.document_id,
      hash: r.hash,
      commitHash: r.commit_hash || undefined,
      createdAt: r.created_at,
    }));
  }

  /**
   * 分页或按条件查询文档列表
   */
  listDocumentsPaged(options: {
    libraryId?: string;
    sourceId?: string;
    limit?: number;
    offset?: number;
  }): Array<{
    id: string;
    sourceId: string;
    sourceKey: string;
    activeRevisionId: string | null;
    status: string;
    libraryId: string;
    createdAt: number;
    updatedAt: number;
  }> {
    const limit = Math.min(Math.max(options.limit || 50, 1), 100);
    const offset = Math.max(options.offset || 0, 0);
    let sql = `
      SELECT d.id, d.source_id, d.source_key, d.active_revision_id, d.status, d.created_at, d.updated_at, s.library_id
      FROM documents d
      JOIN sources s ON s.id = d.source_id
    `;
    const params: any[] = [];
    const where: string[] = [];
    if (options.sourceId) {
      where.push('d.source_id = ?');
      params.push(options.sourceId);
    }
    if (options.libraryId) {
      where.push('s.library_id = ?');
      params.push(options.libraryId);
    }
    if (where.length > 0) {
      sql += ` WHERE ` + where.join(' AND ');
    }
    sql += ` ORDER BY d.updated_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => ({
      id: r.id,
      sourceId: r.source_id,
      sourceKey: r.source_key,
      activeRevisionId: r.active_revision_id,
      status: r.status,
      libraryId: r.library_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * 统计符合条件的文档总数
   */
  countDocuments(options: {
    libraryId?: string;
    sourceId?: string;
  } = {}): number {
    let sql = `
      SELECT COUNT(*) as cnt
      FROM documents d
      JOIN sources s ON s.id = d.source_id
    `;
    const params: any[] = [];
    const where: string[] = [];
    if (options.sourceId) {
      where.push('d.source_id = ?');
      params.push(options.sourceId);
    }
    if (options.libraryId) {
      where.push('s.library_id = ?');
      params.push(options.libraryId);
    }
    if (where.length > 0) {
      sql += ` WHERE ` + where.join(' AND ');
    }
    const row = this.db.prepare(sql).get(...params) as any;
    return row?.cnt || 0;
  }

  /**
   * 查询指定实体
   */
  getEntity(id: string): {
    id: string;
    workspaceId: string;
    path: string;
    container?: string;
    kind: string;
    name: string;
    libraryId: string;
    revisionId: string;
    startLine: number;
    endLine: number;
  } | null {
    const row = this.db.prepare(`SELECT * FROM entities WHERE id = ?`).get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      path: row.path,
      container: row.container || undefined,
      kind: row.kind,
      name: row.name,
      libraryId: row.library_id,
      revisionId: row.revision_id,
      startLine: row.start_line,
      endLine: row.end_line,
    };
  }

  /**
   * 条件查询实体列表
   */
  listEntities(options: {
    libraryIds?: string[];
    workspaceId?: string;
    limit?: number;
  } = {}): Array<{
    id: string;
    workspaceId: string;
    path: string;
    container?: string;
    kind: string;
    name: string;
    libraryId: string;
    revisionId: string;
    startLine: number;
    endLine: number;
  }> {
    const limit = options.limit || 60;
    const where: string[] = [];
    const params: any[] = [];
    if (options.libraryIds && options.libraryIds.length > 0) {
      where.push(`library_id IN (${options.libraryIds.map(() => '?').join(',')})`);
      params.push(...options.libraryIds);
    }
    if (options.workspaceId) {
      where.push(`workspace_id = ?`);
      params.push(options.workspaceId);
    }
    let sql = `SELECT * FROM entities`;
    if (where.length > 0) {
      sql += ` WHERE ` + where.join(' AND ');
    }
    sql += ` ORDER BY path ASC, start_line ASC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      path: r.path,
      container: r.container || undefined,
      kind: r.kind,
      name: r.name,
      libraryId: r.library_id,
      revisionId: r.revision_id,
      startLine: r.start_line,
      endLine: r.end_line,
    }));
  }

  /**
   * 创建或保存沉淀知识条目
   */
  createKnowledgeItem(item: import('./types.js').KnowledgeItem): import('./types.js').KnowledgeItem {
    const createdAt = item.createdAt || Date.now();
    const updatedAt = item.updatedAt || createdAt;
    const evidenceIdsJson = JSON.stringify(item.evidenceIds || []);

    this.db.prepare(`
      INSERT OR REPLACE INTO knowledge_items (
        id, kind, status, text, library_id, evidence_ids, applicability, origin_run_id, supersedes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      item.id,
      item.kind,
      item.status,
      item.text,
      item.libraryId,
      evidenceIdsJson,
      item.applicability || null,
      item.originRunId || null,
      item.supersedes || null,
      createdAt,
      updatedAt
    );

    return { ...item, createdAt, updatedAt };
  }

  /**
   * 获取指定 ID 的知识条目
   */
  getKnowledgeItem(id: string): import('./types.js').KnowledgeItem | null {
    const row = this.db.prepare(`SELECT * FROM knowledge_items WHERE id = ?`).get(id) as any;
    if (!row) return null;
    let evidenceIds: string[] = [];
    try {
      evidenceIds = JSON.parse(row.evidence_ids || '[]');
    } catch {
      evidenceIds = [];
    }
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      text: row.text,
      libraryId: row.library_id,
      evidenceIds,
      applicability: row.applicability || undefined,
      originRunId: row.origin_run_id || undefined,
      supersedes: row.supersedes || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * 列出符合条件的知识条目
   */
  listKnowledgeItems(options: {
    libraryIds?: string[];
    status?: import('./types.js').KnowledgeStatus;
    originRunId?: string;
    limit?: number;
    offset?: number;
  } = {}): import('./types.js').KnowledgeItem[] {
    const limit = Math.min(Math.max(options.limit || 50, 1), 100);
    const offset = Math.max(options.offset || 0, 0);
    const where: string[] = [];
    const params: any[] = [];

    if (options.libraryIds && options.libraryIds.length > 0) {
      where.push(`library_id IN (${options.libraryIds.map(() => '?').join(',')})`);
      params.push(...options.libraryIds);
    }
    if (options.status) {
      where.push(`status = ?`);
      params.push(options.status);
    }
    if (options.originRunId) {
      where.push(`origin_run_id = ?`);
      params.push(options.originRunId);
    }

    let sql = `SELECT * FROM knowledge_items`;
    if (where.length > 0) {
      sql += ` WHERE ` + where.join(' AND ');
    }
    sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((row) => {
      let evidenceIds: string[] = [];
      try {
        evidenceIds = JSON.parse(row.evidence_ids || '[]');
      } catch {
        evidenceIds = [];
      }
      return {
        id: row.id,
        kind: row.kind,
        status: row.status,
        text: row.text,
        libraryId: row.library_id,
        evidenceIds,
        applicability: row.applicability || undefined,
        originRunId: row.origin_run_id || undefined,
        supersedes: row.supersedes || undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

  /**
   * 统计符合条件的知识条目总数
   */
  countKnowledgeItems(options: {
    libraryIds?: string[];
    status?: import('./types.js').KnowledgeStatus;
    originRunId?: string;
  } = {}): number {
    const where: string[] = [];
    const params: any[] = [];

    if (options.libraryIds && options.libraryIds.length > 0) {
      where.push(`library_id IN (${options.libraryIds.map(() => '?').join(',')})`);
      params.push(...options.libraryIds);
    }
    if (options.status) {
      where.push(`status = ?`);
      params.push(options.status);
    }
    if (options.originRunId) {
      where.push(`origin_run_id = ?`);
      params.push(options.originRunId);
    }

    let sql = `SELECT COUNT(*) as cnt FROM knowledge_items`;
    if (where.length > 0) {
      sql += ` WHERE ` + where.join(' AND ');
    }
    const row = this.db.prepare(sql).get(...params) as any;
    return row?.cnt || 0;
  }

  /**
   * 更新知识条目
   */
  updateKnowledgeItem(
    id: string,
    updates: Partial<import('./types.js').KnowledgeItem>
  ): import('./types.js').KnowledgeItem | null {
    const existing = this.getKnowledgeItem(id);
    if (!existing) return null;

    const updated: import('./types.js').KnowledgeItem = {
      ...existing,
      ...updates,
      updatedAt: Date.now(),
    };

    const evidenceIdsJson = JSON.stringify(updated.evidenceIds || []);
    this.db.prepare(`
      UPDATE knowledge_items
      SET kind = ?, status = ?, text = ?, library_id = ?, evidence_ids = ?, applicability = ?, origin_run_id = ?, supersedes = ?, updated_at = ?
      WHERE id = ?
    `).run(
      updated.kind,
      updated.status,
      updated.text,
      updated.libraryId,
      evidenceIdsJson,
      updated.applicability || null,
      updated.originRunId || null,
      updated.supersedes || null,
      updated.updatedAt,
      id
    );

    return updated;
  }

  /**
   * 记录 CaptureJob 作业
   */
  createCaptureJob(job: {
    id: string;
    runId: string;
    status: string;
    error?: string;
    createdAt?: number;
  }): void {
    const createdAt = job.createdAt || Date.now();
    this.db.prepare(`
      INSERT OR REPLACE INTO capture_jobs (id, run_id, status, error, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(job.id, job.runId, job.status, job.error || null, createdAt);
  }

  /**
   * 获取指定 runId 的 CaptureJob
   */
  getCaptureJob(runId: string): {
    id: string;
    runId: string;
    status: string;
    error?: string;
    createdAt: number;
  } | null {
    const row = this.db.prepare(`SELECT * FROM capture_jobs WHERE run_id = ?`).get(runId) as any;
    if (!row) return null;
    return {
      id: row.id,
      runId: row.run_id,
      status: row.status,
      error: row.error || undefined,
      createdAt: row.created_at,
    };
  }

  /**
   * 更新 CaptureJob 状态
   */
  updateCaptureJob(runId: string, status: string, error?: string): void {
    this.db.prepare(`
      UPDATE capture_jobs SET status = ?, error = ? WHERE run_id = ?
    `).run(status, error || null, runId);
  }

  /**
   * 关闭底层数据库
   */
  close(): void {
    this.vectorStore.close();
    if (this.ownsDb) {
      this.db.close();
    }
  }
}
