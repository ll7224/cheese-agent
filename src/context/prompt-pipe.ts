import type { MemoryStore } from '../memory/store.js';
import type { SqliteVectorStore } from '../rag/sqlite-store.js';
import type { PromptContext } from './prompt-builder.js';

export function memoryContext(memoryStore: MemoryStore): (ctx: PromptContext) => string | null {
  return () => memoryStore.buildPromptSection();
}

export function ragContext(vectorStoreOrGetter?: SqliteVectorStore | (() => SqliteVectorStore | null) | null): (ctx: PromptContext) => string | null {
  return () => {
    if (!vectorStoreOrGetter) return null;
    const store = typeof vectorStoreOrGetter === 'function' ? vectorStoreOrGetter() : vectorStoreOrGetter;
    if (!store) return null;
    const size = store.size();
    if (size === 0) return null;
    const sources = store.sources();
    return `[知识库] 已导入 ${size} 个文档片段（来源: ${sources.join(', ')}）。使用 rag_search 工具搜索知识库。`;
  };
}
