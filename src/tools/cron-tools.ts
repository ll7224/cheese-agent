import type { ToolDefinition } from './registry.js';
import type { CronService } from '../cron/service.js';
import type { CronJobConfig, ScheduleType } from '../cron/types.js';

/**
 * 创建面向 Agent 的定时任务管理工具（cron_manage）。
 *
 * 赋予大模型自主创建、删除、查看、立即执行定时任务的能力。
 * 典型应用场景：
 * 1. 用户提出：“每天早晨 9 点提醒我写工作日志” -> Agent 自动调用 `action: 'add'` 注册 cron 任务；
 * 2. “每隔 30 分钟检查一次服务器健康状态” -> Agent 注册 interval 任务；
 * 3. “查看当前有哪些定时任务在运行” -> Agent 调用 `action: 'list'`。
 *
 * @param cronService 定时任务服务实例
 */
export function createCronTool(cronService: CronService): ToolDefinition {
  return {
    name: 'cron_manage',
    description: '管理定时任务。支持创建、删除、查看、立即执行定时任务。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'add', 'remove', 'run', 'enable', 'disable', 'logs'],
          description: '操作类型：list(列出), add(新增), remove(删除), run(立即执行), enable(启用), disable(禁用), logs(查看执行日志)',
        },
        id: {
          type: 'string',
          description: '任务唯一标识 ID（add/remove/run/enable/disable/logs 时使用）',
        },
        name: {
          type: 'string',
          description: '任务显示名称（add 时必填）',
        },
        schedule: {
          type: 'string',
          description: '调度表达式：标准 cron("*/5 * * * *")、相对间隔("every 30s", "every 10m")、一次性时间("2026-09-05T12:00:00Z")',
        },
        prompt: {
          type: 'string',
          description: '任务触发时提交给 Agent 思考执行的 Prompt 指令（add 时与 handler 二选一）',
        },
        handler: {
          type: 'string',
          description: '预设函数处理器名称，如 "random-quote"（add 时与 prompt 二选一）',
        },
      },
      required: ['action'],
    },
    isConcurrencySafe: false,
    isReadOnly: false,
    execute: async (input: {
      action: string;
      id?: string;
      name?: string;
      schedule?: string;
      prompt?: string;
      handler?: any;
    }) => {
      switch (input.action) {
        // 1. 列出当前所有定时任务
        case 'list': {
          const jobs = cronService.list();
          if (jobs.length === 0) return '当前没有定时任务';
          return jobs
            .map((j) => {
              const last = j.lastRun
                ? ` | 上次执行: ${j.lastRun.status} @ ${j.lastRun.finishedAt}`
                : '';
              return `[${j.status}] ${j.config.id} — ${j.config.name}\n  调度: ${j.config.schedule}${last}`;
            })
            .join('\n\n');
        }

        // 2. 动态新增定时任务
        case 'add': {
          if (!input.id || !input.name || !input.schedule || (!input.prompt && !input.handler)) {
            return '添加任务需要完整参数: id, name, schedule, 以及 prompt 或 handler';
          }
          // 推断调度类型
          const scheduleType: ScheduleType = input.schedule.startsWith('every')
            ? 'interval'
            : /^\d{4}-/.test(input.schedule)
              ? 'once'
              : 'cron';

          const payload = input.handler
            ? { type: 'handler' as const, handler: input.handler }
            : { type: 'agent' as const, prompt: input.prompt! };

          const config: CronJobConfig = {
            id: input.id,
            name: input.name,
            schedule: input.schedule,
            scheduleType,
            enabled: true,
            payload,
            source: 'runtime',
          };

          try {
            cronService.add(config);
            return `✓ 任务 "${input.name}" 已创建，调度规则: ${input.schedule}`;
          } catch (err: any) {
            return `✗ 创建失败: ${err.message}`;
          }
        }

        // 3. 删除指定定时任务
        case 'remove': {
          if (!input.id) return '需要指定任务 id';
          return cronService.remove(input.id)
            ? `✓ 任务 ${input.id} 已删除`
            : `✗ 任务 ${input.id} 不存在`;
        }

        // 4. 立即触发执行任务
        case 'run': {
          if (!input.id) return '需要指定任务 id';
          return cronService.runNow(input.id);
        }

        // 5. 重新激活启用任务
        case 'enable': {
          if (!input.id) return '需要指定任务 id';
          return cronService.enable(input.id)
            ? `✓ 任务 ${input.id} 已启用`
            : `✗ 任务 ${input.id} 不存在`;
        }

        // 6. 暂停禁用任务
        case 'disable': {
          if (!input.id) return '需要指定任务 id';
          return cronService.disable(input.id)
            ? `✓ 任务 ${input.id} 已禁用`
            : `✗ 任务 ${input.id} 不存在`;
        }

        // 7. 查询最近历史运行日志
        case 'logs': {
          const logs = cronService.getRecentLogs(input.id, 5);
          if (logs.length === 0) return '暂无执行记录';
          return logs
            .map(
              (l) =>
                `[${l.status}] ${l.jobId} @ ${l.startedAt}\n  输出: ${
                  l.output?.slice(0, 100) || l.error || ''
                }`,
            )
            .join('\n\n');
        }

        default:
          return `未知操作类型: ${input.action}`;
      }
    },
  };
}
