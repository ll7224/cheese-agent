import type { CronJobConfig, CronJobState, RunLog, JobPayload } from './types.js';
import { parseSchedule, getNextCronTime } from './parser.js';
import { CronStore } from './store.js';

/** 内置 Handler（如 'random-quote'）使用的名言警句库 */
const QUOTES = [
  '"知之为知之，不知为不知，是知也。" —— 孔子',
  '"学而不思则罔，思而不学则殆。" —— 孔子',
  '"千里之行，始于足下。" —— 老子',
  '"天行健，君子以自强不息。" —— 《周易》',
  '"不积跬步，无以至千里。" —— 荀子',
  '"Stay hungry, stay foolish." —— Steve Jobs',
  '"The best way to predict the future is to invent it." —— Alan Kay',
  '"Talk is cheap. Show me the code." —— Linus Torvalds',
  '"Simplicity is the ultimate sophistication." —— Leonardo da Vinci',
  '"First, solve the problem. Then, write the code." —— John Johnson',
];

/**
 * 外部执行器接口：桥接 Agent 核心执行能力与通知渠道
 */
export interface CronExecutor {
  /** 触发 Agent 思考循环执行特定的 Prompt 指令，支持单次执行超时设置 */
  runAgentPrompt: (prompt: string, timeout?: number) => Promise<string>;
  /** 可选的任务完成通知回调（例如向终端或即时通讯渠道发送消息） */
  notify?: (message: string) => void;
}

/**
 * 定时任务调度中枢服务（CronService）。
 *
 * 核心设计特色：
 * 1. 动态自驱调度：基于 Node.js 动态计算的 `setTimeout` 递归链，避免低效的秒级轮询占用 CPU；
 * 2. 多重调度模式支持：无缝支持 Cron 表达式、自然语言间隔（Interval）以及绝对时间点（Once）；
 * 3. 连续失败熔断机制：达到连续最大失败次数（maxRetries，默认3次）后自动禁用（enabled=false），防止恶性循环；
 * 4. 防并发重入保护：`running` 标志位确保单任务不会在前一次执行尚未结束前被重复调度拉起；
 * 5. 状态机分层解耦：区分静态配置文件任务（config）与运行时动态创建任务（runtime）。
 */
export class CronService {
  /** 运行时维护的内存任务表（Key 为 jobId） */
  private jobs = new Map<string, CronJobState>();
  /** 本地文件持久化存储器 */
  private store: CronStore;
  /** 驱动任务执行的具体实现器（由外部 index/agent 注入） */
  private executor?: CronExecutor;
  /** 服务整体启动运行状态 */
  private running = false;

  constructor(baseDir = '.') {
    this.store = new CronStore(baseDir);
    this.store.init();
  }

  /**
   * 注入执行器（通常在系统初始化阶段绑定 AgentLoop 和消息通道）
   */
  setExecutor(executor: CronExecutor): void {
    this.executor = executor;
  }

  /**
   * 从持久化存储（.cron/jobs.json）中加载历史任务到内存
   */
  load(): void {
    const configs = this.store.loadJobs();
    for (const config of configs) {
      if (config.enabled) {
        this.jobs.set(config.id, {
          config,
          timerId: null,
          consecutiveFailures: 0,
          running: false,
        });
      }
    }
  }

  /**
   * 启动调度器引擎，激活所有已启用的任务
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    for (const state of this.jobs.values()) {
      if (state.config.enabled) this.scheduleJob(state);
    }
  }

  /**
   * 停止调度器引擎，清除所有内存中的挂起定时器
   */
  stop(): void {
    this.running = false;
    for (const state of this.jobs.values()) {
      if (state.timerId) {
        clearTimeout(state.timerId);
        state.timerId = null;
      }
    }
  }

  /**
   * 新增一个定时任务（同时自动持久化并在运行中时直接激活）
   * @param config 任务配置参数
   */
  add(config: CronJobConfig): void {
    if (this.jobs.has(config.id)) {
      throw new Error(`任务 ${config.id} 已存在`);
    }
    const state: CronJobState = {
      config,
      timerId: null,
      consecutiveFailures: 0,
      running: false,
    };
    this.jobs.set(config.id, state);
    this.persist();
    if (this.running && config.enabled) this.scheduleJob(state);
  }

  /**
   * 删除指定的定时任务并注销挂起的定时器
   * @param id 任务 ID
   */
  remove(id: string): boolean {
    const state = this.jobs.get(id);
    if (!state) return false;
    if (state.timerId) clearTimeout(state.timerId);
    this.jobs.delete(id);
    this.persist();
    return true;
  }

  /**
   * 重新启用已被禁用的任务并重置失败计数器
   * @param id 任务 ID
   */
  enable(id: string): boolean {
    const state = this.jobs.get(id);
    if (!state) return false;
    state.config.enabled = true;
    state.consecutiveFailures = 0;
    this.persist();
    if (this.running) this.scheduleJob(state);
    return true;
  }

  /**
   * 手动禁用某任务并取消定时挂起
   * @param id 任务 ID
   */
  disable(id: string): boolean {
    const state = this.jobs.get(id);
    if (!state) return false;
    state.config.enabled = false;
    if (state.timerId) {
      clearTimeout(state.timerId);
      state.timerId = null;
    }
    this.persist();
    return true;
  }

  /**
   * 获取所有任务的详细运行状态与上次执行历史
   */
  list(): Array<{ config: CronJobConfig; status: string; lastRun?: RunLog }> {
    return Array.from(this.jobs.values()).map((state) => ({
      config: state.config,
      status: state.running
        ? 'running'
        : !state.config.enabled
          ? 'disabled'
          : state.timerId
            ? 'scheduled'
            : 'idle',
      lastRun: state.lastRun,
    }));
  }

  /**
   * 立即触发一次任务执行（无视定时器倒计时，直接执行）
   * @param id 任务 ID
   */
  async runNow(id: string): Promise<string> {
    const state = this.jobs.get(id);
    if (!state) return `任务 ${id} 不存在`;
    return this.executeJob(state);
  }

  /**
   * 查询指定任务或全量任务的最近运行日志
   */
  getRecentLogs(jobId?: string, limit?: number): RunLog[] {
    return this.store.getRecentLogs(jobId, limit);
  }

  /**
   * 核心调度逻辑：计算下次执行时间差（delayMs）并注册下一次执行的回调链
   */
  private scheduleJob(state: CronJobState): void {
    if (state.timerId) {
      clearTimeout(state.timerId);
      state.timerId = null;
    }

    try {
      const parsed = parseSchedule(state.config.schedule);
      let delayMs: number;

      switch (parsed.type) {
        case 'interval':
          delayMs = parsed.intervalMs!;
          break;
        case 'once': {
          const diff = parsed.onceAt!.getTime() - Date.now();
          if (diff <= 0) {
            // 已过目标时间，立即补发执行一次
            this.executeJob(state);
            return;
          }
          delayMs = diff;
          break;
        }
        case 'cron':
          delayMs = getNextCronTime(parsed.cronFields!);
          break;
      }

      // 使用单次定时器驱动任务执行，并在执行完毕后动态递归排期下一次
      state.timerId = setTimeout(async () => {
        await this.executeJob(state);
        // 若为周期性任务且依然保持启用状态，则递归排期下一次执行
        if (parsed.type !== 'once' && state.config.enabled && this.running) {
          this.scheduleJob(state);
        } else if (parsed.type === 'once') {
          // 一次性任务完成后自动从持久化列表注销
          this.remove(state.config.id);
        }
      }, delayMs);
    } catch (err: any) {
      console.log(`  [cron] ✗ 调度失败 ${state.config.id}: ${err.message}`);
    }
  }

  /**
   * 执行单个任务的具体过程（含生命周期记录、超时控制、连续重试计数与熔断）
   */
  private async executeJob(state: CronJobState): Promise<string> {
    // 1. 防重入保护：如果前一次调用未结束，拒绝重复执行
    if (state.running) return '任务正在执行中';
    state.running = true;

    const startedAt = new Date().toISOString();
    let output = '';
    let status: RunLog['status'] = 'success';
    let error: string | undefined;

    try {
      const timeout = state.config.timeout || 60000;
      output = await this.runPayload(state.config.payload, timeout);
      // 执行成功，重置连续失败计数器
      state.consecutiveFailures = 0;
    } catch (err: any) {
      status = err.message?.includes('timeout') ? 'timeout' : 'error';
      error = err.message;
      output = `执行失败: ${err.message}`;
      state.consecutiveFailures++;

      // 2. 连续失败熔断机制
      const maxRetries = state.config.maxRetries ?? 3;
      if (state.consecutiveFailures >= maxRetries) {
        state.config.enabled = false;
        console.log(`  [cron] ✗ ${state.config.id} 连续失败 ${maxRetries} 次，已自动禁用`);
        this.persist();
      }
    } finally {
      state.running = false;
    }

    // 3. 组装并写入执行审计日志
    const log: RunLog = {
      jobId: state.config.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      status,
      output: output.slice(0, 1000),
      error,
    };
    state.lastRun = log;
    this.store.appendLog(log);

    // 4. 发送外部通知
    if (this.executor?.notify) {
      const icon = status === 'success' ? '✓' : '✗';
      this.executor.notify(`[cron] ${icon} ${state.config.name}: ${output.slice(0, 200)}`);
    }

    return output;
  }

  /**
   * 根据 Payload 类型分发执行具体的业务内容
   */
  private async runPayload(payload: JobPayload, timeout: number): Promise<string> {
    if (!this.executor) {
      return '[cron] 未设置执行器，无法运行任务';
    }

    // 分支 1：Agent Prompt 触发模式（将 prompt 交由 AgentLoop 执行）
    if (payload.type === 'agent') {
      return this.executor.runAgentPrompt(payload.prompt, timeout);
    }

    // 分支 2：内置函数/插件 Handler 模式
    if (payload.type === 'handler') {
      if (payload.handler === 'random-quote') {
        return QUOTES[Math.floor(Math.random() * QUOTES.length)];
      }
      return `[handler] ${payload.handler} — handler 类型需要通过插件注册`;
    }

    return '未知 payload 类型';
  }

  /**
   * 将内存中的动态任务（source === 'runtime'）保存到磁盘文件
   */
  private persist(): void {
    const configs = Array.from(this.jobs.values())
      .filter((s) => s.config.source === 'runtime')
      .map((s) => s.config);
    const existing = this.store.loadJobs().filter((j) => j.source === 'config');
    this.store.saveJobs([...existing, ...configs]);
  }
}

