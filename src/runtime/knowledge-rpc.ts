import { z } from 'zod';
import type { KnowledgeService } from '../knowledge/service.js';
import type { KnowledgeContext, KnowledgeRequest, KnowledgeRpc } from '../knowledge/types.js';

export const SearchRequestSchema = z
  .object({
    query: z.string(),
    mode: z.enum(['fact', 'experience']).default('fact'),
    topK: z.number().int().positive().max(100).default(5),
    libraryIds: z.array(z.string()).optional(),
    includeGraph: z.boolean().optional(),
  })
  .strict();

export const CitationRequestSchema = z
  .object({
    citationId: z.string().min(1),
  })
  .strict();

export const GraphRequestSchema = z
  .object({
    entityId: z.string().min(1),
    hops: z.union([z.literal(1), z.literal(2)]).default(1),
  })
  .strict();

export const IngestRequestSchema = z
  .object({
    path: z.string().optional(),
    content: z.string().optional(),
    name: z.string().optional(),
    libraryId: z.string().min(1),
  })
  .strict();

export const KnowledgeRequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('search'), input: SearchRequestSchema }),
  z.object({ op: z.literal('citation'), input: CitationRequestSchema }),
  z.object({ op: z.literal('graph'), input: GraphRequestSchema }),
  z.object({ op: z.literal('ingest'), input: IngestRequestSchema }),
]);

export const RPC_TIMEOUT_MS = 15000;

/**
 * 主进程端：基于可信执行上下文构造受限的 KnowledgeRpc 分发函数
 */
export function createKnowledgeRpcDispatcher(
  service: KnowledgeService,
  ctx: KnowledgeContext,
  signal?: AbortSignal
): KnowledgeRpc {
  return async (rawRequest: KnowledgeRequest): Promise<unknown> => {
    signal?.throwIfAborted();

    // 严格校验请求入参，拒绝未定义字段与非法操作
    const validated = KnowledgeRequestSchema.parse(rawRequest);

    let timeoutTimer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutTimer = setTimeout(() => {
        reject(new Error(`Knowledge RPC request timed out (${RPC_TIMEOUT_MS}ms)`));
      }, RPC_TIMEOUT_MS);
    });

    try {
      const result = await Promise.race([
        service.dispatch(ctx, validated as KnowledgeRequest),
        timeoutPromise,
      ]);
      return result;
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }
  };
}
