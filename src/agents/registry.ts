import type { SubAgentRun, SubAgentConfig } from './types.js';
import { DEFAULT_CONFIG } from './types.js';

/**
 * 子 Agent 注册中心与状态机协调器（SubAgentRegistry）。
 *
 * 核心职责：
 * 1. 资源配额与并发限流：控制派生嵌套深度（防止递归 fork 炸弹）与最大并发实例数；
 * 2. 运行时生命周期管理：维护活跃任务（running）与历史已归档任务（completed/error）；
 * 3. 运行实例唯一标识（ID）生成器。
 */
export class SubAgentRegistry {
  /** 维护所有子 Agent 运行状态记录的内存哈希表（Key 为 runId） */
  private runs = new Map<string, SubAgentRun>();
  /** 限流与超时资源配置 */
  private config: SubAgentConfig;
  /** 自增序列计数器 */
  private idCounter = 0;

  constructor(config?: Partial<SubAgentConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 生成全局唯一的子 Agent 运行 ID，形如 `sub-1-8f2a`
   */
  generateId(): string {
    return `sub-${++this.idCounter}-${Date.now().toString(36).slice(-4)}`;
  }

  /**
   * 准入鉴权与资源容量检测：判断当前是否允许派生新的子 Agent。
   *
   * 熔断拦截条件：
   * 1. 超过最大调用嵌套深度（maxSpawnDepth），防止子 Agent 无限调用子 Agent 导致系统失控；
   * 2. 超过最大并发数（maxConcurrent），防止同时发起过多模型推理撑爆 API 速率限制。
   *
   * @param currentDepth 当前调用栈的嵌套深度
   * @returns 准入判定结果（含拒绝原因）
   */
  canSpawn(currentDepth: number): { ok: boolean; reason?: string } {
    if (currentDepth >= this.config.maxSpawnDepth) {
      return { ok: false, reason: `已达最大嵌套深度 ${this.config.maxSpawnDepth}` };
    }

    const activeCount = this.getActiveRuns().length;
    if (activeCount >= this.config.maxConcurrent) {
      return { ok: false, reason: `已达最大并发数 ${this.config.maxConcurrent}，等待现有任务完成` };
    }

    return { ok: true };
  }

  /**
   * 注册一个新的子 Agent 运行实例
   */
  register(run: SubAgentRun): void {
    this.runs.set(run.id, run);
  }

  /**
   * 标记子 Agent 运行成功，并回填结果文本与完成时间
   *
   * @param id 任务 runId
   * @param result 最终产出的任务总结结果
   */
  complete(id: string, result: string): void {
    const run = this.runs.get(id);
    if (!run) return;
    run.status = 'completed';
    run.result = result;
    run.finishedAt = new Date().toISOString();
  }

  /**
   * 标记子 Agent 运行失败，并记录异常信息
   *
   * @param id 任务 runId
   * @param error 异常原因描述
   */
  fail(id: string, error: string): void {
    const run = this.runs.get(id);
    if (!run) return;
    run.status = 'error';
    run.error = error;
    run.finishedAt = new Date().toISOString();
  }

  /**
   * 根据 ID 查询特定子 Agent 的运行状态
   */
  get(id: string): SubAgentRun | undefined {
    return this.runs.get(id);
  }

  /**
   * 获取当前所有正在运行中（running）的子 Agent 实例列表
   */
  getActiveRuns(): SubAgentRun[] {
    return Array.from(this.runs.values()).filter((r) => r.status === 'running');
  }

  /**
   * 获取系统中记录的所有子 Agent 实例列表（包括历史记录）
   */
  getAllRuns(): SubAgentRun[] {
    return Array.from(this.runs.values());
  }

  /**
   * 获取当前的限流与配额配置
   */
  getConfig(): SubAgentConfig {
    return this.config;
  }
}

