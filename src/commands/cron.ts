import type { CommandHandler } from './index.js';
import type { CronService } from '../cron/service.js';

/**
 * 创建与 Cron 定时任务交互的 CLI 控制台命令处理器。
 *
 * 支持指令：
 * 1. `/cron` 或 `/cron list`：以美化格式列出系统所有定时任务、执行状态（运行中/排期中/已禁用）与调度规则；
 * 2. `/cron logs`：打印最近 10 条定时任务的真实执行历史记录（包括状态、耗时、执行摘要与异常）。
 *
 * @param cronService 定时任务调度中枢服务实例
 */
export function createCronCommands(cronService: CronService): CommandHandler[] {
  const handler: CommandHandler = (cmd) => {
    if (!cmd.startsWith('/cron')) return false;
    const sub = cmd.slice(5).trim();

    // 指令分支 1：列出任务清单（/cron 或 /cron list）
    if (!sub || sub === 'list') {
      const jobs = cronService.list();
      if (jobs.length === 0) {
        console.log('  暂无定时任务');
      } else {
        console.log(`  定时任务 (${jobs.length}):`);
        for (const j of jobs) {
          // 状态图标映射
          const icon =
            j.status === 'running'
              ? '⟳'
              : j.status === 'scheduled'
                ? '◉'
                : j.status === 'disabled'
                  ? '○'
                  : '·';
          console.log(
            `    ${icon} ${j.config.id} — ${j.config.name} [${j.config.schedule}] (${j.status})`,
          );
        }
      }
      return true;
    }

    // 指令分支 2：查看执行审计日志（/cron logs）
    if (sub === 'logs') {
      const logs = cronService.getRecentLogs(undefined, 10);
      if (logs.length === 0) {
        console.log('  暂无执行记录');
      } else {
        console.log('  最近执行记录:');
        for (const l of logs) {
          const icon = l.status === 'success' ? '✓' : '✗';
          console.log(
            `    ${icon} ${l.jobId} @ ${l.startedAt} — ${
              l.output?.slice(0, 80) || l.error || ''
            }`,
          );
        }
      }
      return true;
    }

    // 默认输出帮助用法
    console.log('  用法: /cron [list|logs]');
    return true;
  };
  return [handler];
}
