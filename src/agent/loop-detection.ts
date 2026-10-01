import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

// --- 类型定义 ---

/**
 * 工具调用历史记录项
 */
export interface ToolCallRecord {
  /** 被调用的工具名称 (如 'read_file', 'bash') */
  toolName: string;
  /** 工具参数的确定性哈希指纹（基于稳定排序的参数 JSON） */
  argsHash: string;
  /** 工具执行返回结果的哈希指纹（可选，结果返回后回填） */
  resultHash?: string;
  /** 调用发生时的时间戳 (ms) */
  timestamp: number;
}

/**
 * 死循环检测类型枚举：
 * - 'generic_repeat': 通用重复调用（同一工具相同入参连续或高频出现）
 * - 'ping_pong': 乒乓交替循环（工具 A 与工具 B 之间死循环交替调用）
 * - 'global_circuit_breaker': 全局熔断（工具调用且结果恒定不变，无任何实际进展）
 */
export type DetectorKind = 'generic_repeat' | 'ping_pong' | 'global_circuit_breaker';

/**
 * 循环检测评估结果：
 * - stuck: false 表示状态正常，未检测到死循环。
 * - stuck: true 包含告警级别 ('warning' 提示模型 / 'critical' 强制中断熔断)、检测器类型及用户提示文案。
 */
export type DetectionResult =
  | { stuck: false }
  | { stuck: true; level: 'warning' | 'critical'; detector: DetectorKind; count: number; message: string };

// --- 配置常量 ---

/** 滑动检测窗口大小（保留最近 N 次工具调用记录） */
const HISTORY_SIZE = 30;
/** 警告阈值：触发系统提示词介入，引导模型改变策略 */
const WARNING_THRESHOLD = 5;
/** 严重阈值：判定陷入无法自愈的死循环，触发强制中断 */
const CRITICAL_THRESHOLD = 8;
/** 熔断阈值：结果完全恒定且无进展的重复阈值 */
const BREAKER_THRESHOLD = 10;

// --- 确定性指纹计算 ---

/**
 * 对象稳定序列化（Stable JSON Stringify）。
 * 对 Object 的 Key 进行字典序排序，确保无论入参字段属性顺序如何变动，
 * 只要语义内容一致，生成的字符串恒定一致。
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`).join(',')}}`;
}

/**
 * 计算字符串的 SHA256 哈希前缀（取前 16 位，兼顾防碰撞与内存轻量化）
 */
function hash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * 为单次工具调用生成唯一样本指纹：format: `${toolName}:${hash(stableParams)}`
 */
export function hashToolCall(toolName: string, params: unknown): string {
  return `${toolName}:${hash(stableStringify(params))}`;
}

/**
 * 为工具执行结果生成哈希指纹
 */
export function hashResult(result: unknown): string {
  return hash(stableStringify(result));
}

// --- 滑动窗口状态存储 ---

const histories = new AsyncLocalStorage<ToolCallRecord[]>();
const fallbackHistory: ToolCallRecord[] = [];

/**
 * 记录一次新工具调用的发起（写入滑动窗口，维持队列大小上限）
 */
export function recordCall(toolName: string, params: unknown): void {
  const history = histories.getStore() || fallbackHistory;
  history.push({
    toolName,
    argsHash: hashToolCall(toolName, params),
    timestamp: Date.now(),
  });
  if (history.length > HISTORY_SIZE) history.shift();
}

/**
 * 回填工具执行的结果指纹。
 * 逆序查找历史记录中第一个尚未填充 resultHash 的对应调用并记录。
 */
export function recordResult(toolName: string, params: unknown, result: unknown): void {
  const history = histories.getStore() || fallbackHistory;
  const argsHash = hashToolCall(toolName, params);
  const resultH = hashResult(result);
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].toolName === toolName && history[i].argsHash === argsHash && !history[i].resultHash) {
      history[i].resultHash = resultH;
      break;
    }
  }
}

/**
 * 重置历史调用记录（在每次 Agent 新一轮对话开始时调用）
 */
export function resetHistory(): void {
  histories.enterWith([]);
}

// --- 核心检测算法 ---

/**
 * 检测“无进展连续调用”（No-Progress Streak）。
 * 计算从最近一次往前看，同一工具+相同参数连续调用且返回结果指纹完全相同的次数。
 */
function getNoProgressStreak(toolName: string, argsHash: string): number {
  const history = histories.getStore() || fallbackHistory;
  let streak = 0;
  let lastResultHash: string | undefined;

  for (let i = history.length - 1; i >= 0; i--) {
    const r = history[i];
    if (r.toolName !== toolName || r.argsHash !== argsHash) continue;
    if (!r.resultHash) continue;
    if (!lastResultHash) {
      lastResultHash = r.resultHash;
      streak = 1;
      continue;
    }
    if (r.resultHash !== lastResultHash) break;
    streak++;
  }
  return streak;
}

/**
 * 检测“乒乓交互”（Ping-Pong Alternation）。
 * 识别形态如：A -> B -> A -> B -> A 的交替调用震荡。
 */
function getPingPongCount(currentHash: string): number {
  const history = histories.getStore() || fallbackHistory;
  if (history.length < 3) return 0;

  const last = history[history.length - 1];
  let otherHash: string | undefined;
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].argsHash !== last.argsHash) {
      otherHash = history[i].argsHash;
      break;
    }
  }
  if (!otherHash) return 0;

  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const expected = count % 2 === 0 ? last.argsHash : otherHash;
    if (history[i].argsHash !== expected) break;
    count++;
  }

  if (currentHash === otherHash && count >= 2) return count + 1;
  return 0;
}

// --- 主检测入口 ---

/**
 * 在工具真正执行之前进行前置模式检测。
 * 综合评估三种异常模式：无进展重复 -> 乒乓振荡 -> 频次异常。
 */
export function detect(toolName: string, params: unknown): DetectionResult {
  const history = histories.getStore() || fallbackHistory;
  const argsHash = hashToolCall(toolName, params);

  // 1. 检测无进展重复（结果恒定不变）
  const noProgress = getNoProgressStreak(toolName, argsHash);
  if (noProgress >= BREAKER_THRESHOLD) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'global_circuit_breaker',
      count: noProgress,
      message: `[熔断] ${toolName} 已重复 ${noProgress} 次且无进展，强制停止`,
    };
  }

  // 2. 检测乒乓交替循环（两个工具或两种参数互相死循环）
  const pingPong = getPingPongCount(argsHash);
  if (pingPong >= CRITICAL_THRESHOLD) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'ping_pong',
      count: pingPong,
      message: `[熔断] 检测到乒乓循环（${pingPong} 次交替），强制停止`,
    };
  }
  if (pingPong >= WARNING_THRESHOLD) {
    return {
      stuck: true,
      level: 'warning',
      detector: 'ping_pong',
      count: pingPong,
      message: `[警告] 检测到乒乓循环（${pingPong} 次交替），建议换个思路`,
    };
  }

  // 3. 检测通用高频相同参数调用（滑动窗口内的总体重复度）
  const recentCount = history.filter(h => h.toolName === toolName && h.argsHash === argsHash).length;

  if (recentCount >= CRITICAL_THRESHOLD) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'generic_repeat',
      count: recentCount,
      message: `[熔断] ${toolName} 相同参数已调用 ${recentCount} 次，强制停止`,
    };
  }
  if (recentCount >= WARNING_THRESHOLD) {
    return {
      stuck: true,
      level: 'warning',
      detector: 'generic_repeat',
      count: recentCount,
      message: `[警告] ${toolName} 相同参数已调用 ${recentCount} 次，你可能陷入了重复`,
    };
  }

  // 无异常，放行
  return { stuck: false };
}
