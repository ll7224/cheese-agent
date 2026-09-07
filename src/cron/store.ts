import fs from 'node:fs';
import type { CronJobConfig, RunLog } from './types.js';

/** 定时任务配置持久化文件路径（相对于 baseDir） */
const JOBS_FILE = '.cron/jobs.json';
/** 定时任务运行日志追加文件路径（JSON Lines 格式，便于流式追加与日志审计） */
const LOGS_FILE = '.cron/logs.jsonl';

/**
 * 定时任务持久化存储管理类（CronStore）。
 *
 * 职责：
 * 1. 负责管理本地 `.cron/` 目录结构；
 * 2. 读写 `jobs.json` 保存动态注册的任务配置；
 * 3. 追加写 `logs.jsonl` 记录每一次任务触发的审计详情，支持尾部读取最近执行记录。
 */
export class CronStore {
  /**
   * @param baseDir 工作区根目录路径，默认为当前目录 '.'
   */
  constructor(private baseDir: string = '.') {}

  private get jobsPath() {
    return `${this.baseDir}/${JOBS_FILE}`;
  }

  private get logsPath() {
    return `${this.baseDir}/${LOGS_FILE}`;
  }

  /**
   * 确保本地存储目录存在
   */
  init(): void {
    const dir = `${this.baseDir}/.cron`;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  /**
   * 从 `jobs.json` 读取所有已持久化的任务配置清单
   * @returns 任务配置数组，文件不存在或损坏时平滑回退为空数组
   */
  loadJobs(): CronJobConfig[] {
    if (!fs.existsSync(this.jobsPath)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(this.jobsPath, 'utf-8'));
      return data.jobs || [];
    } catch {
      return [];
    }
  }

  /**
   * 将当前任务配置全量覆写持久化至 `jobs.json`
   * @param jobs 最新的任务配置列表
   */
  saveJobs(jobs: CronJobConfig[]): void {
    this.init();
    fs.writeFileSync(this.jobsPath, JSON.stringify({ jobs }, null, 2));
  }

  /**
   * 向 `logs.jsonl` 以流式追加模式写入单次任务执行日志
   * @param log 运行记录对象
   */
  appendLog(log: RunLog): void {
    this.init();
    fs.appendFileSync(this.logsPath, JSON.stringify(log) + '\n');
  }

  /**
   * 获取最近的历史执行日志（支持按 jobId 过滤与数量限制）
   *
   * @param jobId 可选的任务 ID 过滤条件
   * @param limit 获取的最大记录条数，默认 10 条
   * @returns 按时间顺序从旧到新排列的最近日志切片
   */
  getRecentLogs(jobId?: string, limit = 10): RunLog[] {
    if (!fs.existsSync(this.logsPath)) return [];
    const lines = fs
      .readFileSync(this.logsPath, 'utf-8')
      .split('\n')
      .filter(Boolean);

    let logs: RunLog[] = lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean) as RunLog[];

    if (jobId) logs = logs.filter((l) => l.jobId === jobId);
    return logs.slice(-limit);
  }
}

