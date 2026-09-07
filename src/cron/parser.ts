import { Cron } from 'croner';
import type { ScheduleType } from './types.js';

/**
 * 表达式解析后产出的统一结构体
 */
export interface ParsedSchedule {
  /** 调度模式类型 */
  type: ScheduleType;
  /** interval 类型：计算出的下次触发固定间隔毫秒数 */
  intervalMs?: number;
  /** cron 类型：基于 croner 库生成的表达式解析实例 */
  cronInstance?: Cron;
  /** once 类型：目标触发的绝对时间点 */
  onceAt?: Date;
  /** 兼容传递的 cron 实例引用 */
  cronFields?: any;
}

/**
 * 相对间隔时间正则匹配模式：
 * 匹配 "every 10s", "every 30sec", "every 5m", "every 1hour" 等自然语言时间表述
 */
const INTERVAL_RE = /^every\s+(\d+)\s*(s|sec|m|min|h|hour)s?$/i;

/**
 * 统一调度表达式解析器。
 *
 * 语法支持范围：
 * 1. 相对时间间隔（Interval）：例如 "every 30s"、"every 10m"、"every 2h"；
 * 2. 绝对时间点（Once）：ISO 8601 日期时间字符串，如 "2026-09-05T12:00:00Z"；
 * 3. 标准 Cron 表达式（Cron）：五字段或六字段表达式，如 "0 9 * * *"（每天早上9点）、"* /5 * * * *"（每5分钟）。
 *
 * @param expr 调度表达式字符串
 * @returns 解析后的标准化调度参数对象
 */
export function parseSchedule(expr: string): ParsedSchedule {
  // 1. 尝试匹配自然语言相对间隔 "every X [s|m|h]"
  const intervalMatch = expr.match(INTERVAL_RE);
  if (intervalMatch) {
    const value = parseInt(intervalMatch[1], 10);
    const unit = intervalMatch[2].toLowerCase();
    const multiplier = unit.startsWith('h')
      ? 3600000
      : unit.startsWith('m')
        ? 60000
        : 1000;
    return { type: 'interval', intervalMs: value * multiplier };
  }

  // 2. 尝试匹配 ISO 时间戳格式（执行一次后即废弃的延迟任务）
  if (/^\d{4}-\d{2}-\d{2}/.test(expr)) {
    const date = new Date(expr);
    if (!isNaN(date.getTime())) {
      return { type: 'once', onceAt: date };
    }
  }

  // 3. 默认作为标准 Cron 表达式解析（基于 croner 引擎）
  const cronInstance = new Cron(expr);
  return { type: 'cron', cronInstance, cronFields: cronInstance };
}

/**
 * 计算基于当前时间到达下一次 Cron 触发点的毫秒倒计时。
 *
 * @param cron croner 实例
 * @returns 距离下次执行的毫秒数，若计算失败则默认保底 60 秒
 */
export function getNextCronTime(cron: Cron): number {
  return cron.msToNext() ?? 60000;
}
