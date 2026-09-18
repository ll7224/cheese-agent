import type { ModelMessage } from 'ai';
import { randomUUID } from 'node:crypto';
import type { ToolRegistry } from '../tools/registry.js';
import type { SubAgentRegistry } from './registry.js';
import type { SpawnRequest, SubAgentRun } from './types.js';
import { agentLoop } from '../agent/loop.js';
import { Pool } from '../runtime/pool.js';
import type { ExecutionOptions } from '../runtime/events.js';

export interface SpawnContext extends ExecutionOptions {
  model: any;
  registry: ToolRegistry;
  agentRegistry: SubAgentRegistry;
  buildSystem: () => string;
  currentDepth: number;
}

const localPool = new Pool(Number(process.env.CHEESE_MAX_CHILDREN || 3));

export async function spawnAgent(request: SpawnRequest, ctx: SpawnContext, index = 0): Promise<string> {
  if (ctx.currentDepth >= ctx.agentRegistry.getConfig().maxSpawnDepth) return '[spawn] 拒绝: 已达最大嵌套深度';
  const childRunId = randomUUID();
  const run: SubAgentRun = { id: childRunId, task: request.task, status: 'queued', depth: ctx.currentDepth + 1, startedAt: new Date().toISOString() };
  ctx.agentRegistry.register(run);
  const emit = (event: Record<string, unknown>) => ctx.emit?.({ ...event, type: String(event.type), childRunId });
  emit({ type: 'child-status', task: request.task, status: 'queued' });
  let release: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new AbortController();
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout.signal]) : timeout.signal;
  const messages: ModelMessage[] = [{ role: 'user', content: request.task }];
  try {
    release = await (ctx.acquireChild ? ctx.acquireChild(childRunId) : localPool.acquire(ctx.signal));
    signal.throwIfAborted();
    run.status = 'running';
    run.startedAt = new Date().toISOString();
    emit({ type: 'child-status', status: 'running', task: request.task });
    timer = setTimeout(() => timeout.abort(), request.timeout || ctx.agentRegistry.getConfig().defaultTimeout);
    const registry = ctx.registry.fork(new Set(['spawn_agent']), request.tools);
    await agentLoop(ctx.model, registry, messages, `${ctx.buildSystem()}\n你是子 Agent。完成指定任务后直接输出结论。`, undefined, { emit, signal });
    signal.throwIfAborted();
    const last = [...messages].reverse().find(message => message.role === 'assistant');
    const result = typeof last?.content === 'string' ? last.content : (last?.content as any[] || []).filter(part => part.type === 'text').map(part => part.text).join('');
    ctx.agentRegistry.complete(childRunId, result);
    emit({ type: 'child-status', status: 'completed', result });
    return result;
  } catch (error) {
    run.status = ctx.signal?.aborted ? 'cancelled' : timeout.signal.aborted ? 'timeout' : 'error';
    run.error = error instanceof Error ? error.message : String(error);
    run.finishedAt = new Date().toISOString();
    emit({ type: 'child-status', status: run.status, error: run.error });
    return `[子 Agent ${run.status}] ${run.error}`;
  } finally { clearTimeout(timer); release?.(); }
}

export async function spawnParallel(requests: SpawnRequest[], ctx: SpawnContext): Promise<Array<{ task: string; result: string }>> {
  return Promise.all(requests.map(async (request, index) => ({ task: request.task, result: await spawnAgent(request, ctx, index) })));
}
