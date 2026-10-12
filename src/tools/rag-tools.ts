import fs from 'node:fs';
import type { ToolDefinition } from './registry.js';
import { chunkDocument } from '../rag/chunker.js';
import { embed, type EmbeddingFn } from '../rag/embedder.js';
import { VectorStore } from '../rag/store.js';
import { hybridSearch } from '../rag/search.js';
import { SqliteVectorStore } from '../rag/sqlite-store.js';

export function createRagTools(vectorStore: SqliteVectorStore, embedFn: EmbeddingFn): ToolDefinition[] {
  const ragIngestTool: ToolDefinition = {
    name: 'rag_ingest',
    description: '将文档导入知识库。path 为文件路径，collection 可选指定集合 ID（默认 "default"）。内容会被分块、向量化后存储。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文档路径' },
        collection: { type: 'string', description: '知识库集合 ID（可选，默认 "default"）' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
    isReadOnly: false,
    execute: async ({ path, collection }: { path: string; collection?: string }) => {
      try {
        const text = fs.readFileSync(path, 'utf-8');
        const chunks = chunkDocument(path, text);
        const colId = collection || 'default';
        const embeddings = await embed(embedFn, chunks.map(c => c.text));
        vectorStore.addBatch(chunks.map((c, i) => ({ chunk: c, embedding: embeddings[i], collectionId: colId })), colId);
        return `已导入 ${chunks.length} 个文档片段（来源: ${path}，集合: ${colId}）。知识库该集合共 ${vectorStore.size(colId)} 个片段。`;
      } catch (e: any) {
        return `导入失败: ${e.message}`;
      }
    },
  };

  const ragSearchTool: ToolDefinition = {
    name: 'rag_search',
    description: '从知识库中搜索相关信息。返回最相关的文档片段。可指定 collection 过滤。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索查询' },
        top_k: { type: 'number', description: '返回结果数量（默认 5）' },
        collection: { type: 'string', description: '限定搜索的知识库集合 ID（可选）' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async ({ query, top_k, collection }: { query: string; top_k?: number; collection?: string }) => {
      const collections = collection ? [collection] : undefined;
      if (vectorStore.size(collections) === 0) return '指定知识库为空，请先使用 rag_ingest 导入文档。';
      const results = await vectorStore.hybridSearch(embedFn, query, top_k || 5, collections);
      if (results.length === 0) return `没有找到与 "${query}" 相关的内容。`;
      return results.map((r, i) =>
        `[${i + 1}] 来源: ${r.chunk.source} (集合: ${r.chunk.collectionId || 'default'}) | 综合分: ${r.score.toFixed(3)} (向量: ${r.vectorScore.toFixed(2)}, 关键词: ${r.keywordScore.toFixed(2)})\n${r.chunk.text.slice(0, 500)}`
      ).join('\n\n---\n\n');
    },
  };

  return [ragIngestTool, ragSearchTool];
}
