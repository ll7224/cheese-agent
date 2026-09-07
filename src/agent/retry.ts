// --- 错误分类与重试策略 ---

/**
 * 判断错误是否属于可恢复/可重试的网络与服务端异常。
 *
 * 【重试判定矩阵】：
 * 1. HTTP 状态码分类：
 *    - 429: 请求速率超限（Rate Limit / Quota Exceeded） -> 可重试
 *    - 529: 服务端过载（Site Overloaded） -> 可重试
 *    - 408: 请求超时（Request Timeout） -> 可重试
 *    - 5xx (500~599): 服务端内部错误、网关不可用 -> 可重试
 *    - 4xx (400~499 其他): 客户端参数错误、鉴权失败、非法请求 -> 不可重试
 * 2. Node.js 底层网络连接异常：
 *    - ECONNRESET, EPIPE: 连接被对端重置或管道破损 -> 可重试
 *    - ETIMEDOUT, timeout: 套接字/传输层超时 -> 可重试
 *    - fetch failed, network: 跨域/网络层握手失败 -> 可重试
 * 3. 大语言模型特定错误：
 *    - 'No output generated': 模型单次未吐出 token，允许重新发起 -> 可重试
 *
 * @param error - 捕获的未知异常对象
 * @returns boolean - 是否应触发自动退避重试
 */
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message || '';

  // 匹配错误信息中的 3 位 HTTP 状态码
  const statusMatch = message.match(/(\d{3})/);
  if (statusMatch) {
    const status = parseInt(statusMatch[1]);
    if ([429, 529, 408].includes(status)) return true;
    if (status >= 500 && status < 600) return true;
    if (status >= 400 && status < 500) return false;
  }

  // 匹配底层网络与连接类关键字
  if (message.includes('ECONNRESET') || message.includes('EPIPE')) return true;
  if (message.includes('ETIMEDOUT') || message.includes('timeout')) return true;
  if (message.includes('fetch failed') || message.includes('network')) return true;
  if (message.includes('No output generated')) return true;

  return false;
}

// --- 指数退避 + 随机抖动 (Full Jitter Exponential Backoff) ---

/**
 * 计算下次重试前的休眠等待时长 (ms)。
 *
 * 【算法公式】：
 * Delay = min(baseMs * 2^(attempt - 1), maxMs) ± 25% Jitter
 *
 * 引入随机抖动的核心目的：
 * 避免在网关故障或限流解除时，大量并发的 Agent 实例在相同的时间点同时重试，
 * 从而引发二次尖峰冲击（Thundering Herd Problem / 惊群效应）。
 *
 * @param attempt - 当前重试轮次序号（从 1 开始递增）
 * @param baseMs - 基础退避基数，默认 500ms
 * @param maxMs - 最大退避硬上限，默认 30000ms (30s)
 * @returns 最终经过抖动扰动后的等待时长（毫秒）
 */
export function calculateDelay(attempt: number, baseMs = 500, maxMs = 30000): number {
  const exponential = baseMs * Math.pow(2, attempt - 1);
  const capped = Math.min(exponential, maxMs);
  const jitterRange = capped * 0.25;
  const jittered = capped + (Math.random() * 2 - 1) * jitterRange;
  return Math.max(0, Math.round(jittered));
}

/**
 * 异步等待函数 (Promise 封装的 setTimeout)
 *
 * @param ms - 暂停等待的毫秒数
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
