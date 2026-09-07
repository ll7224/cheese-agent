/**
 * 任务调度触发类型定义：
 * - 'cron': 标准 Cron 表达式（如 "0 9 * * *" 每日 9 点，"* /5 * * * *" 每 5 分钟）
 * - 'interval': 相对固定间隔（如 "every 30s", "every 5m", "every 2h"）
 * - 'once': 一次性延迟任务，在指定 ISO 时间戳触发执行一次后自动注销
 */
export type ScheduleType = 'cron' | 'interval' | 'once';

/**
 * 定时任务配置定义
 */
export interface CronJobConfig {
  /** 任务唯一英文标识符（例如: "daily-report", "health-check"） */
  id: string;
  /** 任务显示名称 */
  name: string;
  /** 可选的任务详细描述 */
  description?: string;
  /** 原始调度表达式：标准 5 字段 Cron | 间隔语法如 "every 30s" | 目标时间 ISO 字符串 */
  schedule: string;
  /** 解析后的调度类型 */
  scheduleType: ScheduleType;
  /** 任务是否处于启用调度状态 */
  enabled: boolean;
  /** 任务实际执行的内容负载（Agent Prompt 或内置 Handler） */
  payload: JobPayload;
  /** 单次执行超时时间，单位 ms，默认 60000 (1分钟) */
  timeout?: number;
  /** 容灾熔断阈值：连续失败多少次后自动停用该任务，默认 3 次 */
  maxRetries?: number;
  /**
   * 任务配置来源：
   * - 'config': 来自项目硬编码静态配置文件（不可被运行时删除）
   * - 'runtime': 运行时由 Agent 或用户动态创建（可持久化到本地并允许增删改查）
   */
  source: 'config' | 'runtime';
}

/**
 * 任务执行载荷联合类型（Payload）：
 * - 'agent': 将指定的 Prompt 发送给 Agent 核心循环自动执行，实现定时自主唤醒
 * - 'handler': 触发特定预定义的函数处理器（如名言轮播、系统检测等）
 */
export type JobPayload =
  | { type: 'agent'; prompt: string }
  | { type: 'handler'; handler: string };

/**
 * 任务单次运行历史审计日志
 */
export interface RunLog {
  /** 关联的任务 ID */
  jobId: string;
  /** 任务启动时间（ISO 8601 格式字符串） */
  startedAt: string;
  /** 任务结束时间（ISO 8601 格式字符串） */
  finishedAt: string;
  /** 执行结果状态：成功、异常失败、超时中断 */
  status: 'success' | 'error' | 'timeout';
  /** 执行产出摘要或日志（截断保留前 1000 字符） */
  output?: string;
  /** 错误堆栈或异常描述 */
  error?: string;
}

/**
 * 运行时内存中的任务调度状态机模型
 */
export interface CronJobState {
  /** 静态任务配置 */
  config: CronJobConfig;
  /** Node.js 下次触发定时器句柄（null 表示当前未激活或已暂停） */
  timerId: ReturnType<typeof setTimeout> | null;
  /** 最近一次执行历史日志 */
  lastRun?: RunLog;
  /** 当前已累计的连续失败次数（成功后自动清零） */
  consecutiveFailures: number;
  /** 当前是否正处于异步执行中（防并发重入） */
  running: boolean;
}

