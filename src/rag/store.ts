import type { Chunk } from './chunker.js';

/**
 * 持久化存储在向量库中的切片对象结构。
 * 在基础 Chunk 结构之上，扩展了向量数据（embedding）与入库时间戳（addedAt）。
 */
export interface StoredChunk extends Chunk {
  /** 当前切片的密集向量表示（由 Embedder 运算生成，如 128 维数组） */
  embedding: number[];
  /** 写入/更新的时间戳（毫秒数） */
  addedAt: number;
}

/**
 * 纯内存向量数据库（In-Memory Vector Store）。
 *
 * 职责：
 * 1. 维护文档分块（Chunk）与其对应向量（Embedding）的存储；
 * 2. 支持单条与批量写入，根据 Chunk ID 自动去重与覆写；
 * 3. 提供数据读取、大小统计、清理以及来源文档聚合能力。
 */
export class VectorStore {
  /** 内存切片容器，维护所有已注册的切片及向量 */
  private chunks: StoredChunk[] = [];

  /**
   * 向向量库添加一条切片及其向量。
   * 支持幂等性：如果已存在相同 ID 的 Chunk，则直接覆盖并刷新时间戳。
   *
   * @param chunk 文本切片对象
   * @param embedding 对应的向量表示
   */
  add(chunk: Chunk, embedding: number[]): void {
    const existing = this.chunks.findIndex((c) => c.id === chunk.id);
    if (existing >= 0) {
      // 存在则更新
      this.chunks[existing] = { ...chunk, embedding, addedAt: Date.now() };
    } else {
      // 不存在则追加
      this.chunks.push({ ...chunk, embedding, addedAt: Date.now() });
    }
  }

  /**
   * 批量添加切片和向量。
   *
   * @param items 包含 chunk 与对应 embedding 的数组
   */
  addBatch(items: Array<{ chunk: Chunk; embedding: number[] }>): void {
    for (const { chunk, embedding } of items) {
      this.add(chunk, embedding);
    }
  }

  /**
   * 获取当前向量库中的全部切片数据（包括其向量与元信息）。
   * 供检索器（Searcher）做全库打分或遍历匹配使用。
   */
  getAll(): StoredChunk[] {
    return this.chunks;
  }

  /**
   * 获取当前库内切片的总条数。
   */
  size(): number {
    return this.chunks.length;
  }

  /**
   * 清空整个向量库。
   */
  clear(): void {
    this.chunks = [];
  }

  /**
   * 获取向量库中所有不重复的文档来源列表（如文件路径或 URL 集合）。
   */
  sources(): string[] {
    return [...new Set(this.chunks.map((c) => c.source))];
  }
}
