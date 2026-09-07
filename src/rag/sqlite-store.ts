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

  /**
   * 初始化数据库并挂载 sqlite-vec 向量扩展插件。
   *
   * @param dbPath SQLite 数据库文件路径（默认保存在当前目录的 'knowledge.db'）
   */
  constructor(dbPath: string = 'knowledge.db') {
    this.db = new Database(dbPath);
    // 加载 sqlite-vec 动态扩展库，赋予 SQLite 向量计算与 vec0 虚拟表支持能力
    sqliteVec.load(this.db);
    this.createTables();
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
        updated_at INTEGER NOT NULL
      );

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
   */
  add(chunk: Chunk, embedding: number[]): void {
    const now = Date.now();

    // 1. 写入/替换普通元数据表
    this.db.prepare(`
      INSERT OR REPLACE INTO chunks
        (id, text, source, chunk_index, embedding, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      chunk.id,
      chunk.text,
      chunk.source,
      chunk.index,
      JSON.stringify(embedding),
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
   */
  addBatch(items: Array<{ chunk: Chunk; embedding: number[] }>): void {
    const tx = this.db.transaction(() => {
      for (const { chunk, embedding } of items) {
        this.add(chunk, embedding);
      }
    });
    tx(); // 执行事务提交
  }

  /**
   * 路径 1：基于 sqlite-vec 的纯向量密集检索（Dense Retrieval）。
   *
   * @param queryEmbedding 查询语句生成的特征向量
   * @param topK 需要召回的最相近候选数量
   * @returns 检索命中的切片及相似度得分（范围 [0, 1]，值越接近 1 越相关）
   */
  vectorSearch(queryEmbedding: number[], topK: number): Array<{ chunk: StoredChunk; score: number }> {
    const buf = Buffer.from(new Float32Array(queryEmbedding).buffer);
    // 通过 MATCH 语法调用 sqlite-vec 内部向量距离排序
    const rows = this.db.prepare(`
      SELECT v.id, v.distance, c.text, c.source, c.chunk_index, c.embedding
      FROM chunks_vec v
      JOIN chunks c ON c.id = v.id
      WHERE v.embedding MATCH ?
      ORDER BY v.distance
      LIMIT ?
    `).all(buf, topK) as any[];

    return rows.map((r) => ({
      chunk: {
        id: r.id,
        text: r.text,
        source: r.source,
        index: r.chunk_index,
        tokenEstimate: Math.ceil(r.text.length / 4),
        embedding: JSON.parse(r.embedding),
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
   * @returns 命中的切片及归一化相关度得分
   */
  keywordSearch(query: string, topK: number): Array<{ chunk: StoredChunk; score: number }> {
    // 调用 FTS5 内置的 bm25() 算法对全文匹配项进行打分排序
    const rows = this.db.prepare(`
      SELECT f.id, bm25(chunks_fts) AS rank, c.text, c.source, c.chunk_index, c.embedding
      FROM chunks_fts f
      JOIN chunks c ON c.id = f.id
      WHERE chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query, topK) as any[];

    return rows.map((r) => ({
      chunk: {
        id: r.id,
        text: r.text,
        source: r.source,
        index: r.chunk_index,
        tokenEstimate: Math.ceil(r.text.length / 4),
        embedding: JSON.parse(r.embedding),
        addedAt: 0,
      },
      // FTS5 的 bm25() 返回值通常为负数（越小代表越相关），将其转换为 [0, 1] 正向得分
      score: r.rank < 0 ? -r.rank / (1 - r.rank) : 1 / (1 + r.rank),
    }));
  }

  /**
   * 获取当前知识库中的切片总数量。
   */
  size(): number {
    return (this.db.prepare('SELECT COUNT(*) as n FROM chunks').get() as any).n;
  }

  /**
   * 清空三张表中的全部数据。
   */
  clear(): void {
    this.db.exec('DELETE FROM chunks; DELETE FROM chunks_vec; DELETE FROM chunks_fts;');
  }

  /**
   * 查询所有已入库的去重来源列表（如文件路径、URL 等）。
   */
  sources(): string[] {
    return (this.db.prepare('SELECT DISTINCT source FROM chunks').all() as any[]).map((r) => r.source);
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
   */
  async hybridSearch(
    embedFn: EmbeddingFn,
    query: string,
    topK: number = 5,
  ): Promise<SearchResult[]> {
    // 候选池按 topK * 4 放大，若总条数不足则取当前库总数
    const candidateCount = Math.min(topK * 4, this.size());
    if (candidateCount === 0) return [];

    // 计算 Query 向量
    const [queryVec] = await embed(embedFn, [query]);

    // 路径 1: sqlite-vec 密集向量检索
    const vectorResults = this.vectorSearch(queryVec, candidateCount);

    // 路径 2: FTS5 稀疏关键词检索
    const keywordResults = this.keywordSearch(query, candidateCount);

    // 双路分数 Min-Max 归一化
    const vecScores = normalizeMinMax(vectorResults.map((r) => r.score));
    const kwScores = normalizeMinMax(keywordResults.map((r) => r.score));

    // 加权外连接合并候选池
    const candidates = new Map<string, SearchResult>();

    // 放入向量路结果
    for (let i = 0; i < vectorResults.length; i++) {
      const id = vectorResults[i].chunk.id;
      candidates.set(id, {
        chunk: vectorResults[i].chunk,
        score: vecScores[i] * 0.7,
        vectorScore: vecScores[i],
        keywordScore: 0,
      });
    }

    // 融合关键词路结果
    for (let i = 0; i < keywordResults.length; i++) {
      const id = keywordResults[i].chunk.id;
      const existing = candidates.get(id);
      if (existing) {
        // 双路重合项，累加关键词加权分
        existing.keywordScore = kwScores[i];
        existing.score += kwScores[i] * 0.3;
      } else {
        // 纯关键词命中项，追加为候选
        candidates.set(id, {
          chunk: keywordResults[i].chunk,
          score: kwScores[i] * 0.3,
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
