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
   * @param collectionId 可选所属集合 ID（默认 'default'）
   */
  add(chunk: Chunk, embedding: number[], collectionId?: string): void {
    const colId = collectionId || chunk.collectionId || 'default';
    const item: StoredChunk = { ...chunk, collectionId: colId, embedding, addedAt: Date.now() };
    const existing = this.chunks.findIndex((c) => c.id === chunk.id);
    if (existing >= 0) {
      // 存在则更新
      this.chunks[existing] = item;
    } else {
      // 不存在则追加
      this.chunks.push(item);
    }
  }

  /**
   * 批量添加切片和向量。
   *
   * @param items 包含 chunk 与对应 embedding 的数组
   * @param defaultCollectionId 默认所属集合 ID
   */
  addBatch(items: Array<{ chunk: Chunk; embedding: number[]; collectionId?: string }>, defaultCollectionId?: string): void {
    for (const { chunk, embedding, collectionId } of items) {
      this.add(chunk, embedding, collectionId || defaultCollectionId);
    }
  }

  /**
   * 获取当前向量库中的全部切片数据（包括其向量与元信息）。
   * 供检索器（Searcher）做全库打分或遍历匹配使用。
   *
   * @param collectionIds 可选指定的集合 ID 列表过滤
   */
  getAll(collectionIds?: string[]): StoredChunk[] {
    if (!collectionIds) return this.chunks;
    if (collectionIds.length === 0) return [];
    const set = new Set(collectionIds);
    return this.chunks.filter((c) => set.has(c.collectionId || 'default'));
  }

  /**
   * 获取当前库内切片的总条数。
   *
   * @param collectionIds 可选集合 ID 或集合 ID 列表
   */
  size(collectionIds?: string[] | string): number {
    if (!collectionIds) return this.chunks.length;
    const filter = Array.isArray(collectionIds) ? collectionIds : [collectionIds];
    return this.getAll(filter).length;
  }

  /**
   * 清空整个向量库或指定集合。
   *
   * @param collectionId 可选清空指定的集合
   */
  clear(collectionId?: string): void {
    if (!collectionId) {
      this.chunks = [];
    } else {
      this.chunks = this.chunks.filter((c) => (c.collectionId || 'default') !== collectionId);
    }
  }

  /**
   * 获取向量库中所有不重复的文档来源列表（如文件路径或 URL 集合）。
   *
   * @param collectionIds 可选指定集合 ID 过滤
   */
  sources(collectionIds?: string[] | string): string[] {
    const list = collectionIds
      ? this.getAll(Array.isArray(collectionIds) ? collectionIds : [collectionIds])
      : this.chunks;
    return [...new Set(list.map((c) => c.source))];
  }
}
