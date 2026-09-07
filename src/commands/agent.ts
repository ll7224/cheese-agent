import type { CommandHandler } from './index.js';
import type { SubAgentRegistry } from '../agents/registry.js';

/**
 * 创建与子 Agent（Sub-Agent）运行状态观测相关的 CLI 控制台指令。
 *
 * 支持指令：
 * 1. `/agents`：查看当前系统中所有子 Agent 的运行记录列表、执行状态（运行中/已完成/失败）、
 *    嵌套深度（depth）、执行结果截取以及当前并发与深度配额使用情况。
 *
 * @param agentRegistry 子 Agent 注册中心实例
 */
export function createAgentCommands(agentRegistry: SubAgentRegistry): CommandHandler[] {
  const handler: CommandHandler = (cmd) => {
    if (!cmd.startsWith('/agents')) return false;

    const runs = agentRegistry.getAllRuns();
    if (runs.length === 0) {
      console.log('  暂无子 Agent 记录');
    } else {
      const active = runs.filter((r) => r.status === 'running');
      const completed = runs.filter((r) => r.status === 'completed');
      const failed = runs.filter((r) => r.status === 'error');

      console.log(`  子 Agent 记录 (${runs.length}):`);
      for (const r of runs) {
        const icon =
          r.status === 'running'
            ? '⟳'
            : r.status === 'completed'
              ? '✓'
              : '✗';
        const detail =
          r.status === 'completed'
            ? `${r.result?.slice(0, 60)}...`
            : r.status === 'error'
              ? r.error
              : '执行中...';
        console.log(`    ${icon} ${r.id} (depth=${r.depth}) — ${r.task.slice(0, 40)}`);
        console.log(`      ${detail}`);
      }

      const config = agentRegistry.getConfig();
      console.log(
        `\n  活跃: ${active.length}/${config.maxConcurrent} | 完成: ${completed.length} | 失败: ${failed.length}`,
      );
      console.log(
        `  最大深度: ${config.maxSpawnDepth} | 最大并发: ${config.maxConcurrent}`,
      );
    }
    return true;
  };

  return [handler];
}
