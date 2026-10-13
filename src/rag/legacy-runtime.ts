import { SqliteVectorStore } from './sqlite-store.js';

let legacyVectorStore: SqliteVectorStore | null = null;

/**
 * 延迟初始化旧 CLI RAG 向量存储。
 * 避免在模块导入阶段或 worker 启动时无条件打开旧 knowledge.db。
 */
export function getLegacyRag(enabled: boolean = true, dbPath: string = 'knowledge.db'): SqliteVectorStore {
  if (!legacyVectorStore) {
    legacyVectorStore = new SqliteVectorStore(enabled ? dbPath : ':memory:');
  }
  return legacyVectorStore;
}

/**
 * 重置/关闭旧 RAG 连接（主要用于测试清理或退出）
 */
export function resetLegacyRag(): void {
  if (legacyVectorStore) {
    try {
      legacyVectorStore.close();
    } catch {}
    legacyVectorStore = null;
  }
}
