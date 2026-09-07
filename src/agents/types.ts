/**
 * 子 Agent 运行时限流与资源隔离配置
 */
export interface SubAgentConfig {
  /** 最大递归嵌套派生深度（例如父 Agent 深度为 0，派生的子 Agent 深度为 1，默认 1 级） */
  maxSpawnDepth: number;
  /** 最大允许同时运行的子 Agent 并发数量，默认 3 */
  maxConcurrent: number;
  /** 单个子 Agent 执行的默认超时毫秒数，默认 60000 (60秒) */
  defaultTimeout: number;
}

/**
 * 默认子 Agent 资源配额与限流基线
 */
export const DEFAULT_CONFIG: SubAgentConfig = {
  maxSpawnDepth: 1,
  maxConcurrent: 3,
  defaultTimeout: 60000,
};

/**
 * 派发子 Agent 时的请求入参体
 */
export interface SpawnRequest {
  /** 明确指派给子 Agent 独立探索或执行的具体任务描述（Prompt） */
  task: string;
  /** 允许子 Agent 调用的工具白名单（可选，默认继承父 Agent 工具集并排除自递归派生工具） */
  tools?: string[];
  /** 单次执行超时时间，单位 ms */
  timeout?: number;
}

/**
 * 单个子 Agent 生命周期的运行时状态实例记录
 */
export interface SubAgentRun {
  /** 子 Agent 运行的唯一跟踪 ID（如 "sub-1-8f2a"） */
  id: string;
  /** 指派的具体任务内容 */
  task: string;
  /** 运行生命周期状态：运行中、已完成、发生异常、超时终止 */
  status: 'running' | 'completed' | 'error' | 'timeout';
  /** 当前所处的调用嵌套深度（父 Agent 深度为 0） */
  depth: number;
  /** 任务启动时间戳（ISO 字符串） */
  startedAt: string;
  /** 任务完成/结束时间戳（ISO 字符串） */
  finishedAt?: string;
  /** 最终执行成功输出的文本结果/摘要 */
  result?: string;
  /** 异常失败时的错误信息或堆栈 */
  error?: string;
}

  