import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type { Chunk } from './chunker.js';
import type { StoredChunk } from './store.js';
import { DIMS, embed, type EmbeddingFn } from './embedder.js';
import { mmrSelect, type SearchResult } from './search.js';

/**
 * 基于 SQLite + sqlite-vec + FTS5 的持久化混合向量数据库。
 *
 * 核心架构特色（三表联动）：
 * 1. 基础关系表（chunks）：存储切片的完整原文、来源、顺序索引与 JSON 向量元数据；
 * 2. 向量虚表（chunks_vec）：基于 sqlite-vec 的 vec0 扩展引擎，提供高性能 C 语言级向量相似度检索；
 * 3. 全文检索虚表（chunks_fts）：基于 SQLite 内置 FTS5 引擎，提供基于 BM25 算法的高性能关键词检索；
 * 4. 内置混合检索引擎（hybridSearch）：支持多路召回、Min-Max 分数对齐、加权融合与 MMR 多样性重排。
 */
export class SqliteVectorStore {
  /** Better-SQLite3 原生数据库连接句柄 */
  private db: Database.Database;
  private ownsDb: boolean = true;

  /**
   * 初始化数据库并挂载 sqlite-vec 向量扩展插件。
   *
   * @param dbOrPath SQLite 数据库文件路径或已有连接
   */
  constructor(dbOrPath: string | Database.Database = 'knowledge.db') {
    if (typeof dbOrPath === 'string') {
      this.db = new Database(dbOrPath);
      this.ownsDb = true;
    } else {
      this.db = dbOrPath;
      this.ownsDb = false;
    }
    // 加载 sqlite-vec 动态扩展库，赋予 SQLite 向量计算与 vec0 虚拟表支持能力
    try {
      sqliteVec.load(this.db);
    } catch {
      // 若已加载则忽略
    }
    this.createTables();
  }

  /** 关闭自身持有的数据库连接 */
  close(): void {
    if (this.ownsDb) {
      this.db.close();
    }
  }

  /**
   * 初始化数据库 Schema：原子化创建核心的“三表联动”结构。
   */
  private createTables(): void {
    this.db.exec(`
      -- 1. 核心业务主表：存储结构化字段与切片原始元数据
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        embedding TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT 'text-embedding-v3',
        collection_id TEXT NOT NULL DEFAULT 'default',
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_collection ON chunks(collection_id);

      -- 2. 向量索引虚拟表：vec0 引擎，定长 ${DIMS} 维 Float32 向量
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[${DIMS}]
      );

      -- 3. 全文搜索虚拟表：FTS5 引擎，针对 text 建立全文倒排索引
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text, id UNINDEXED, source UNINDEXED
      );
    `);

    // 检查并自动迁移旧库：若缺少 collection_id 列则自动补齐
    const cols = (this.db.prepare('PRAGMA table_info(chunks)').all() as any[]).map((c) => c.name);
    if (!cols.includes('collection_id')) {
      this.db.exec(`
        ALTER TABLE chunks ADD COLUMN collection_id TEXT NOT NULL DEFAULT 'default';
        CREATE INDEX IF NOT EXISTS idx_chunks_collection ON chunks(collection_id);
      `);
    }
  }

  /**
   * 向数据库同步写入单条切片与其对应的向量（三表联动写入）。
   *
   * 注意事项：
   * - 普通表 chunks 支持原生的 INSERT OR REPLACE 覆盖更新；
   * - 虚拟表（vec0 与 fts5）在 SQLite 底层 C API 中不支持 SQLITE_REPLACE 冲突替换语义，
   *   因此必须显式采取“先 DELETE 后 INSERT”模式，保证幂等且杜绝主键唯一约束报错。
   *
   * @param chunk 文本切片对象
   * @param embedding 浮点向量数组（必须为 ${DIMS} 维）
   * @param collectionId 可选所属集合 ID（默认 'default'）
   */
  add(chunk: Chunk, embedding: number[], collectionId?: string): void {
    const now = Date.now();
    const colId = collectionId || chunk.collectionId || 'default';

    // 1. 写入/替换普通元数据表
    this.db.prepare(`
      INSERT OR REPLACE INTO chunks
        (id, text, source, chunk_index, embedding, collection_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      chunk.id,
      chunk.text,
      chunk.source,
      chunk.index,
      JSON.stringify(embedding),
      colId,
      now
    );

    // 2. 写入/替换 sqlite-vec 向量虚表（转为二进制 Float32Array Buffer 存储）
    this.db.prepare(`DELETE FROM chunks_vec WHERE id = ?`).run(chunk.id);
    this.db.prepare(`
      INSERT INTO chunks_vec (id, embedding)
      VALUES (?, ?)
    `).run(
      chunk.id,
      Buffer.from(new Float32Array(embedding).buffer)
    );

    // 3. 写入/替换 FTS5 全文检索虚表
    this.db.prepare(`DELETE FROM chunks_fts WHERE id = ?`).run(chunk.id);
    this.db.prepare(`
      INSERT INTO chunks_fts (id, text, source)
      VALUES (?, ?, ?)
    `).run(
      chunk.id,
      chunk.text,
      chunk.source
    );
  }

  /**
   * 批量写入切片与向量数据。
   * 采用 SQLite 显式事务（Transaction）包裹，批量写入性能相比单条提交可提升数十倍。
   *
   * @param items 包含切片与向量的数据列表
   * @param defaultCollectionId 默认所属集合 ID
   */
  addBatch(
    items: Array<{ chunk: Chunk; embedding: number[]; collectionId?: string }>,
    defaultCollectionId?: string
  ): void {
    const tx = this.db.transaction(() => {
      for (const { chunk, embedding, collectionId } of items) {
        this.add(chunk, embedding, collectionId || defaultCollectionId);
      }
    });
    tx(); // 执行事务提交
  }

  /**
   * 写入/更新知识索引片段。
   * 当 embedding 缺省或为空时写入元数据及 FTS，清除旧 vec 项，不插入零向量。
   */
  upsertIndexedChunks(
    items: Array<{
      id: string;
      text: string;
      source: string;
      chunkIndex: number;
      collectionId: string;
      embedding?: number[];
    }>
  ): void {
    const now = Date.now();
    const insertChunk = this.db.prepare(`
      INSERT OR REPLACE INTO chunks
        (id, text, source, chunk_index, embedding, collection_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const deleteVec = this.db.prepare(`DELETE FROM chunks_vec WHERE id = ?`);
    const insertVec = this.db.prepare(`
      INSERT INTO chunks_vec (id, embedding)
      VALUES (?, ?)
    `);
    const deleteFts = this.db.prepare(`DELETE FROM chunks_fts WHERE id = ?`);
    const insertFts = this.db.prepare(`
      INSERT INTO chunks_fts (id, text, source)
      VALUES (?, ?, ?)
    `);

    for (const item of items) {
      const hasVec = Array.isArray(item.embedding) && item.embedding.length > 0;
      insertChunk.run(
        item.id,
        item.text,
        item.source,
        item.chunkIndex,
        hasVec ? JSON.stringify(item.embedding) : '[]',
        item.collectionId,
        now
      );

      deleteVec.run(item.id);
      if (hasVec) {
        insertVec.run(
          item.id,
          Buffer.from(new Float32Array(item.embedding!).buffer)
        );
      }

      deleteFts.run(item.id);
      insertFts.run(item.id, item.text, item.source);
    }
  }

  /**
   * 按 ID 列表删除切片及对应的向量、全文索引。
   */
  removeChunks(ids: string[]): void {
    if (ids.length === 0) return;
    const deleteChunk = this.db.prepare(`DELETE FROM chunks WHERE id = ?`);
    const deleteVec = this.db.prepare(`DELETE FROM chunks_vec WHERE id = ?`);
    const deleteFts = this.db.prepare(`DELETE FROM chunks_fts WHERE id = ?`);
    for (const id of ids) {
      deleteChunk.run(id);
      deleteVec.run(id);
      deleteFts.run(id);
    }
  }

  /**
   * 路径 1：基于 sqlite-vec 的纯向量密集检索（Dense Retrieval）。
   *
   * @param queryEmbedding 查询语句生成的特征向量
   * @param topK 需要召回的最相近候选数量
   * @param collectionIds 可选指定的知识库集合过滤列表
   * @returns 检索命中的切片及相似度得分（范围 [0, 1]，值越接近 1 越相关）
   */
  vectorSearch(
    queryEmbedding: number[],
    topK: number,
    collectionIds?: string[]
  ): Array<{ chunk: StoredChunk; score: number }> {
    if (collectionIds && collectionIds.length === 0) return [];

    const buf = Buffer.from(new Float32Array(queryEmbedding).buffer);
    const k = Math.max(topK * 4, 50);

    let rows: any[];
    if (collectionIds && collectionIds.length > 0) {
      const placeholders = collectionIds.map(() => '?').join(',');
      rows = this.db.prepare(`
        SELECT v.id, v.distance, c.text, c.source, c.chunk_index, c.embedding, c.collection_id
        FROM (
          SELECT id, distance
          FROM chunks_vec
          WHERE embedding MATCH ? AND k = ?
        ) v
        JOIN chunks c ON c.id = v.id
        WHERE c.collection_id IN (${placeholders})
        ORDER BY v.distance
        LIMIT ?
      `).all(buf, k, ...collectionIds, topK) as any[];
    } else {
      rows = this.db.prepare(`
        SELECT v.id, v.distance, c.text, c.source, c.chunk_index, c.embedding, c.collection_id
        FROM (
          SELECT id, distance
          FROM chunks_vec
          WHERE embedding MATCH ? AND k = ?
        ) v
        JOIN chunks c ON c.id = v.id
        ORDER BY v.distance
        LIMIT ?
      `).all(buf, k, topK) as any[];
    }

    return rows.map((r) => ({
      chunk: {
        id: r.id,
        text: r.text,
        source: r.source,
        index: r.chunk_index,
        tokenEstimate: Math.ceil(r.text.length / 4),
        embedding: JSON.parse(r.embedding),
        collectionId: r.collection_id,
        addedAt: 0,
      },
      // 将余弦距离（Cosine Distance ∈ [0, 2]）转换为余弦相似度（Cosine Similarity ∈ [-1, 1]）
      score: 1 - r.distance,
    }));
  }

  /**
   * 路径 2：基于 FTS5 的全文关键词稀疏检索（Sparse BM25 Retrieval）。
   *
   * @param query 用户输入的搜索词
   * @param topK 需要召回的候选数量
   * @param collectionIds 可选指定的知识库集合过滤列表
   * @returns 命中的切片及归一化相关度得分
   */
  keywordSearch(
    query: string,
    topK: number,
    collectionIds?: string[]
  ): Array<{ chunk: StoredChunk; score: number }> {
    if (collectionIds && collectionIds.length === 0) return [];

    let rows: any[] = [];
    try {
      if (collectionIds && collectionIds.length > 0) {
        const placeholders = collectionIds.map(() => '?').join(',');
        rows = this.db.prepare(`
          SELECT f.id, bm25(chunks_fts) AS rank, c.text, c.source, c.chunk_index, c.embedding, c.collection_id
          FROM chunks_fts f
          JOIN chunks c ON c.id = f.id
          WHERE chunks_fts MATCH ? AND c.collection_id IN (${placeholders})
          ORDER BY rank
          LIMIT ?
        `).all(query, ...collectionIds, topK) as any[];
      } else {
        rows = this.db.prepare(`
          SELECT f.id, bm25(chunks_fts) AS rank, c.text, c.source, c.chunk_index, c.embedding, c.collection_id
          FROM chunks_fts f
          JOIN chunks c ON c.id = f.id
          WHERE chunks_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        `).all(query, topK) as any[];
      }
    } catch {
      rows = [];
    }

    if (rows.length === 0) {
      // 降级 1: 分词前缀匹配
      const terms = query.trim().split(/\s+/).filter(Boolean);
      if (terms.length > 0) {
        const prefixQuery = terms.map((t) => `${t.replace(/[*"'^:]/g, '')}*`).join(' ');
        try {
          if (collectionIds && collectionIds.length > 0) {
            const placeholders = collectionIds.map(() => '?').join(',');
            rows = this.db.prepare(`
              SELECT f.id, bm25(chunks_fts) AS rank, c.text, c.source, c.chunk_index, c.embedding, c.collection_id
              FROM chunks_fts f
              JOIN chunks c ON c.id = f.id
              WHERE chunks_fts MATCH ? AND c.collection_id IN (${placeholders})
              ORDER BY rank
              LIMIT ?
            `).all(prefixQuery, ...collectionIds, topK) as any[];
          } else {
            rows = this.db.prepare(`
              SELECT f.id, bm25(chunks_fts) AS rank, c.text, c.source, c.chunk_index, c.embedding, c.collection_id
              FROM chunks_fts f
              JOIN chunks c ON c.id = f.id
              WHERE chunks_fts MATCH ?
              ORDER BY rank
              LIMIT ?
            `).all(prefixQuery, topK) as any[];
          }
        } catch {
          rows = [];
        }
      }
    }

    if (rows.length === 0) {
      // 降级 2: LIKE 子串匹配（保障无 CJK 词法分析扩展时的中文字符检索体验）
      try {
        if (collectionIds && collectionIds.length > 0) {
          const placeholders = collectionIds.map(() => '?').join(',');
          rows = this.db.prepare(`
            SELECT c.id, -0.5 AS rank, c.text, c.source, c.chunk_index, c.embedding, c.collection_id
            FROM chunks c
            WHERE c.text LIKE ? AND c.collection_id IN (${placeholders})
            LIMIT ?
          `).all(`%${query.trim()}%`, ...collectionIds, topK) as any[];
        } else {
          rows = this.db.prepare(`
            SELECT c.id, -0.5 AS rank, c.text, c.source, c.chunk_index, c.embedding, c.collection_id
            FROM chunks c
            WHERE c.text LIKE ?
            LIMIT ?
          `).all(`%${query.trim()}%`, topK) as any[];
        }
      } catch {
        rows = [];
      }
    }

    return rows.map((r) => ({
      chunk: {
        id: r.id,
        text: r.text,
        source: r.source,
        index: r.chunk_index,
        tokenEstimate: Math.ceil(r.text.length / 4),
        embedding: JSON.parse(r.embedding),
        collectionId: r.collection_id,
        addedAt: 0,
      },
      // FTS5 的 bm25() 返回值通常为负数（越小代表越相关），将其转换为 [0, 1] 正向得分
      score: r.rank < 0 ? -r.rank / (1 - r.rank) : 1 / (1 + r.rank),
    }));
  }

  /**
   * 获取当前知识库中的切片总数量（可指定集合过滤）。
   *
   * @param collectionIds 可选指定集合 ID 或集合 ID 列表
   */
  size(collectionIds?: string[] | string): number {
    if (!collectionIds) {
      return (this.db.prepare('SELECT COUNT(*) as n FROM chunks').get() as any).n;
    }
    const cols = Array.isArray(collectionIds) ? collectionIds : [collectionIds];
    if (cols.length === 0) return 0;
    const placeholders = cols.map(() => '?').join(',');
    return (
      this.db
        .prepare(`SELECT COUNT(*) as n FROM chunks WHERE collection_id IN (${placeholders})`)
        .get(...cols) as any
    ).n;
  }

  /**
   * 清空整个向量库或指定集合。
   *
   * @param collectionId 可选清空指定的集合 ID
   */
  clear(collectionId?: string): void {
    if (!collectionId) {
      this.db.exec('DELETE FROM chunks; DELETE FROM chunks_vec; DELETE FROM chunks_fts;');
    } else {
      this.db
        .prepare(`DELETE FROM chunks_vec WHERE id IN (SELECT id FROM chunks WHERE collection_id = ?)`)
        .run(collectionId);
      this.db
        .prepare(`DELETE FROM chunks_fts WHERE id IN (SELECT id FROM chunks WHERE collection_id = ?)`)
        .run(collectionId);
      this.db.prepare(`DELETE FROM chunks WHERE collection_id = ?`).run(collectionId);
    }
  }

  /**
   * 查询已入库的去重来源列表（如文件路径、URL 等）。
   *
   * @param collectionIds 可选指定集合 ID 过滤
   */
  sources(collectionIds?: string[] | string): string[] {
    if (!collectionIds) {
      return (this.db.prepare('SELECT DISTINCT source FROM chunks').all() as any[]).map((r) => r.source);
    }
    const cols = Array.isArray(collectionIds) ? collectionIds : [collectionIds];
    if (cols.length === 0) return [];
    const placeholders = cols.map(() => '?').join(',');
    return (
      this.db
        .prepare(`SELECT DISTINCT source FROM chunks WHERE collection_id IN (${placeholders})`)
        .all(...cols) as any[]
    ).map((r) => r.source);
  }

  /**
   * 获取所有存在的集合列表及其切片计数。
   */
  getCollections(): Array<{ id: string; count: number }> {
    return this.db
      .prepare(
        `SELECT collection_id as id, COUNT(*) as count FROM chunks GROUP BY collection_id ORDER BY count DESC`
      )
      .all() as any[];
  }

  /**
   * 混合搜索核心入口：在持久化数据库层直接编排“向量 + 关键词”双路召回与融合重排。
   *
   * 流程：
   * 1. 候选池扩增：单路各召回 `topK * 4` 条候选，留足重排空间；
   * 2. 双路并行召回：同时发起 sqlite-vec 向量检索与 FTS5 关键词检索；
   * 3. 相对分数归一化：采用 Min-Max 将两路分值缩放到统一量纲 [0, 1]；
   * 4. 加权融合打分：综合得分 = 向量得分 * 70% + 关键词得分 * 30%；
   * 5. MMR 多样性重排：剔除重复/同质化片段，最大化返回切片的信息增益。
   *
   * @param embedFn 向量化模型函数
   * @param query 搜索关键词/语句
   * @param topK 最终需要返回的结果数量（默认 5）
   * @param collectionIds 可选指定的集合范围过滤列表
   */
  /**
   * 同步混合检索核心入口：根据已就绪的 query 和可选 vector 执行检索与加权融合。
   *
   * @param query 搜索关键词/语句
   * @param vector 可选查询向量
   * @param topK 最终需要返回的结果数量（默认 5）
   * @param collectionIds 可选指定的集合范围过滤列表
   */
  searchPrepared(
    query: string,
    vector?: number[],
    topK: number = 5,
    collectionIds?: string[]
  ): SearchResult[] {
    if (collectionIds && collectionIds.length === 0) return [];

    const total = this.size(collectionIds);
    const candidateCount = Math.min(topK * 4, total);
    if (candidateCount === 0) return [];

    const hasVec = Array.isArray(vector) && vector.length > 0;
    const hasQuery = Boolean(query && query.trim().length > 0);

    // 路径 1: sqlite-vec 密集向量检索
    const vectorResults = hasVec
      ? this.vectorSearch(vector!, candidateCount, collectionIds)
      : [];

    // 路径 2: FTS5 稀疏关键词检索
    const keywordResults = hasQuery
      ? this.keywordSearch(query, candidateCount, collectionIds)
      : [];

    if (vectorResults.length === 0 && keywordResults.length === 0) {
      return [];
    }

    // 双路分数 Min-Max 归一化
    const vecScores = normalizeMinMax(vectorResults.map((r) => r.score));
    const kwScores = normalizeMinMax(keywordResults.map((r) => r.score));

    // 加权外连接合并候选池
    const candidates = new Map<string, SearchResult>();

    if (hasVec && hasQuery) {
      // 放入向量路结果 (70%)
      for (let i = 0; i < vectorResults.length; i++) {
        const id = vectorResults[i].chunk.id;
        candidates.set(id, {
          chunk: vectorResults[i].chunk,
          score: vecScores[i] * 0.7,
          vectorScore: vecScores[i],
          keywordScore: 0,
        });
      }

      // 融合关键词路结果 (30%)
      for (let i = 0; i < keywordResults.length; i++) {
        const id = keywordResults[i].chunk.id;
        const existing = candidates.get(id);
        if (existing) {
          existing.keywordScore = kwScores[i];
          existing.score += kwScores[i] * 0.3;
        } else {
          candidates.set(id, {
            chunk: keywordResults[i].chunk,
            score: kwScores[i] * 0.3,
            vectorScore: 0,
            keywordScore: kwScores[i],
          });
        }
      }
    } else if (hasVec) {
      for (let i = 0; i < vectorResults.length; i++) {
        const id = vectorResults[i].chunk.id;
        candidates.set(id, {
          chunk: vectorResults[i].chunk,
          score: vecScores[i],
          vectorScore: vecScores[i],
          keywordScore: 0,
        });
      }
    } else {
      for (let i = 0; i < keywordResults.length; i++) {
        const id = keywordResults[i].chunk.id;
        candidates.set(id, {
          chunk: keywordResults[i].chunk,
          score: kwScores[i],
          vectorScore: 0,
          keywordScore: kwScores[i],
        });
      }
    }

    // 初步按总分降序排序
    const sorted = [...candidates.values()].sort((a, b) => b.score - a.score);

    // MMR 多样性筛选去重
    return mmrSelect(sorted, topK);
  }

  /**
   * 混合搜索核心入口：在持久化数据库层直接编排“向量 + 关键词”双路召回与融合重排。
   *
   * @param embedFn 向量化模型函数
   * @param query 搜索关键词/语句
   * @param topK 最终需要返回的结果数量（默认 5）
   * @param collectionIds 可选指定的集合范围过滤列表
   */
  async hybridSearch(
    embedFn: EmbeddingFn,
    query: string,
    topK: number = 5,
    collectionIds?: string[]
  ): Promise<SearchResult[]> {
    if (collectionIds && collectionIds.length === 0) return [];
    const [queryVec] = await embed(embedFn, [query]);
    return this.searchPrepared(query, queryVec, topK, collectionIds);
  }
}

/**
 * Min-Max 线性归一化工具函数：将任意打分数组拉伸至 [0, 1] 区间
 *
 * @param scores 原始分值数组
 */
function normalizeMinMax(scores: number[]): number[] {
  if (scores.length === 0) return [];
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min || 1; // 避免除以 0
  return scores.map((s) => (s - min) / range);
}
