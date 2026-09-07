import type { ToolDefinition } from './registry.js';
import type { SubAgentRegistry } from '../agents/registry.js';
import { spawnAgent, spawnParallel, type SpawnContext } from '../agents/spawn.js';

/**
 * 创建面向大模型的派生子 Agent 工具（spawn_agent）。
 *
 * 核心技术价值：
 * 1. 上下文解耦（Context Isolation）：复杂或冗长的信息收集任务由独立的子 Agent 消化处理，
 *    仅将浓缩总结后的结论回填给主 Agent，大幅降低主会话上下文膨胀与 Token 消耗；
 * 2. 并行扇出（Fan-out Concurrency）：支持通过 `tasks` 数组一次性并发分发多个异构任务（如并发阅读多篇文档、并发搜索多个指标），
 *    各子任务互不阻塞，耗时从 O(N) 降低至 O(1)。
 *
 * @param agentRegistry 子 Agent 运行时注册表
 * @param getSpawnCtx 动态获取当前父级上下文执行环境的回调函数
 */
export function createSpawnTool(
  agentRegistry: SubAgentRegistry,
  getSpawnCtx: () => SpawnContext,
): ToolDefinition {
  return {
    name: 'spawn_agent',
    description:
      '派一个子 Agent 去执行任务。子 Agent 有独立的上下文，完成后返回结果摘要。支持同时派多个子 Agent 并行执行。',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: '单个任务描述（与 tasks 二选一）',
        },
        tasks: {
          type: 'array',
          items: { type: 'string' },
          description: '多个任务描述，并行执行（与 task 二选一）',
        },
      },
    },
    isConcurrencySafe: false,
    isReadOnly: true,
    execute: async (input: { task?: string; tasks?: string[] }) => {
      const ctx = getSpawnCtx();

      // 分支 1：多任务并行分发模式（Fan-out 并发）
      if (input.tasks && input.tasks.length > 0) {
        const requests = input.tasks.map((t) => ({ task: t }));
        const results = await spawnParallel(requests, ctx);
        return results
          .map(
            (r, i) =>
              `## 子 Agent ${i + 1}: ${r.task.slice(0, 40)}\n\n${r.result}`,
          )
          .join('\n\n---\n\n');
      }

      // 分支 2：单任务独立执行模式
      if (input.task) {
        return spawnAgent({ task: input.task }, ctx);
      }

      return '需要提供 task 或 tasks 参数';
    },
  };
}

