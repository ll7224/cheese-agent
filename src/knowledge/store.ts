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
    return { ...input, createdAt };
  }

  /**
   * 查询指定知识库
   */
  getLibrary(id: string): Library | null {
    const row = this.db.prepare(`SELECT * FROM libraries WHERE id = ?`).get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      scope: row.scope,
      workspaceId: row.workspace_id || undefined,
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
        SELECT * FROM libraries WHERE workspace_id = ? OR scope = 'public' ORDER BY created_at ASC
      `).all(workspaceId);
    } else {
      rows = this.db.prepare(`SELECT * FROM libraries ORDER BY created_at ASC`).all();
    }
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      scope: row.scope,
      workspaceId: row.workspace_id || undefined,
      role: row.role,
      createdAt: row.created_at,
    }));
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

      // 7. 递增 generation
      this.db.prepare(`
        UPDATE generation SET version = version + 1 WHERE id = 1
      `).run();

      return { documentId, revisionId };
    });

    return tx();
  }

  /**
   * 删除文档并将其片段移出检索索引（保留历史版本记录）
   */
  deleteDocument(documentId: string): void {
    const tx = this.db.transaction(() => {
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
   * 关闭底层数据库
   */
  close(): void {
    this.vectorStore.close();
    if (this.ownsDb) {
      this.db.close();
    }
  }
}
