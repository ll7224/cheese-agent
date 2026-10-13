import fs from 'node:fs';
import type { ToolDefinition } from './registry.js';
import type { KnowledgeRpc, SearchResponse } from '../knowledge/types.js';

/**
 * 构造绑定指定受限 RPC 客户端的知识中心专用工具集
 */
export function createKnowledgeTools(rpc: KnowledgeRpc, emit?: (event: any) => void): ToolDefinition[] {
  const ragSearchTool: ToolDefinition = {
    name: 'rag_search',
    description: '从工程知识中心搜索相关源码、文档和经验。支持指定模式（fact 或 experience）及关联图谱。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索查询' },
        top_k: { type: 'number', description: '返回结果数量（默认 5）' },
        collection: { type: 'string', description: '兼容参数：指定知识库 ID' },
        library_id: { type: 'string', description: '指定知识库 ID' },
        mode: {
          type: 'string',
          enum: ['fact', 'experience'],
          description: '查询模式：fact（仅已生效事实）或 experience（含经验候选）',
        },
        include_graph: { type: 'boolean', description: '是否包含关联实体与图谱证据' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async (args: any) => {
      try {
        const libId = args.library_id || args.collection;
        const libraryIds = libId ? [libId] : undefined;
        const res = (await rpc({
          op: 'search',
          input: {
            query: args.query,
            topK: args.top_k || 5,
            libraryIds,
            mode: args.mode === 'experience' ? 'experience' : 'fact',
            includeGraph: Boolean(args.include_graph),
          },
        })) as SearchResponse;

        if (!res.hits || res.hits.length === 0) {
          return `没有找到与 "${args.query}" 相关的工程知识。`;
        }

        if (emit) {
          emit({
            type: 'knowledge-used',
            generation: res.generation,
            libraryIds: res.libraryIds,
            citations: res.hits.map((h) => ({
              citationId: h.citation.id,
              libraryId: h.citation.libraryId,
              documentId: h.citation.documentId,
              revisionId: h.citation.revisionId,
              sourceUri: h.citation.sourceUri,
              status: h.citation.status,
              evidenceKind: h.citation.evidenceKind,
            })),
          });
        }

        return res.hits
          .map((h, i) => {
            const c = h.citation;
            const updatePrompt =
              c.status === 'candidate'
                ? ' [提示: 候选经验，尚未正式生效，供参考]'
                : '';
            return `[${i + 1}] 引用ID: ${c.id}\n来源: ${c.sourceUri}:${c.span.startLine}-${c.span.endLine} (库: ${c.libraryId || '默认'}, 状态: ${c.status}${updatePrompt}, 证据类型: ${c.evidenceKind})\n相关度得分: ${h.score.toFixed(3)}\n内容:\n${h.text}`;
          })
          .join('\n\n---\n\n');
      } catch (err: any) {
        return `检索失败: ${err.message}`;
      }
    },
  };

  const ragIngestTool: ToolDefinition = {
    name: 'rag_ingest',
    description: '向工程知识中心项目库导入文档或文本内容。仅允许写入当前工作区项目库。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文档路径' },
        content: { type: 'string', description: '直接导入的文本内容（与 path 二选一）' },
        name: { type: 'string', description: '受管文档名称' },
        collection: { type: 'string', description: '兼容参数：目标知识库 ID' },
        library_id: { type: 'string', description: '目标知识库 ID' },
      },
      additionalProperties: false,
    },
    isConcurrencySafe: false,
    isReadOnly: false,
    execute: async (args: any) => {
      let text = args.content;
      if (!text && args.path) {
        try {
          text = fs.readFileSync(args.path, 'utf-8');
        } catch (e: any) {
          return `无法读取文件: ${e.message}`;
        }
      }
      if (!text) {
        return '导入失败：必须提供 path 或 content。';
      }

      const libraryId = args.library_id || args.collection;
      if (!libraryId) {
        return '导入失败：必须指定目标 libraryId。';
      }

      try {
        const res = (await rpc({
          op: 'ingest',
          input: {
            path: args.path,
            content: text,
            name: args.name || args.path,
            libraryId,
          },
        })) as any;
        return `已成功摄入文档（文档ID: ${res.documentId}, 版本ID: ${res.revisionId}）。`;
      } catch (err: any) {
        return `导入失败: ${err.message}`;
      }
    },
  };

  const knowledgeGraphTool: ToolDefinition = {
    name: 'knowledge_graph',
    description: '查询工程代码结构与局部实体图谱。',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: '目标实体 ID' },
        hops: { type: 'number', enum: [1, 2], description: '探索跳数（1 或 2）' },
      },
      required: ['entity_id'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async (args: any) => {
      try {
        const res = await rpc({
          op: 'graph',
          input: {
            entityId: args.entity_id,
            hops: args.hops === 2 ? 2 : 1,
          },
        });
        return JSON.stringify(res, null, 2);
      } catch (err: any) {
        return `图谱查询失败: ${err.message}`;
      }
    },
  };

  return [ragSearchTool, ragIngestTool, knowledgeGraphTool];
}
