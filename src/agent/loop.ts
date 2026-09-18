import { streamText, type ModelMessage, NoOutputGeneratedError } from 'ai';
import { ToolRegistry } from '../tools/registry.js';
import { detect, recordCall, recordResult, resetHistory } from './loop-detection.js';
import { isRetryable, calculateDelay, sleep } from './retry.js';
import { type UsageTracker, normalizeUsage } from '../usage/tracker.js';
import type { ExecutionOptions } from '../runtime/events.js';

/**
 * Agent 核心运行循环配置常量
 *
 * MAX_STEPS: 单次交互允许的最大推理步数（防止多轮工具调用无限发散）
 * MAX_RETRIES: 单步调用 LLM 发生网络/临时错误时的最大重试次数
 * TOKEN_BUDGET: 单次交互的最大 Token 消耗上限预算（防止成本失控）
 */
const MAX_STEPS = 15;
const MAX_RETRIES = 5;
const TOKEN_BUDGET = 500000;

/**
 * Agent 核心执行循环（ReAct / Tool-Use 驱动引擎）。
 *
 * 【工作机制与设计模式】：
 * 1. 状态机循环（Step-by-Step Loop）：
 *    - 维护当前执行步数与累计 Token 消耗。
 *    - 在每一步，将当前 messages、system prompt 及动态注册的 tools 提交给大语言模型进行流式生成（streamText）。
 * 2. 实时流式响应与工具调用捕获（Stream Parsing）：
 *    - 监听 'text-delta'：向终端实时输出思考与回答。
 *    - 监听 'tool-call'：拦截工具调用请求，接入死循环检测器（Loop Detection）。如果陷入循环，发出警告或触发熔断（critical break）。
 *    - 监听 'tool-result'：记录工具执行输出指纹，便于追踪无进展循环调用。
 * 3. 弹性容错与退避重试（Fault Tolerance）：
 *    - 当遭遇可重试错误（网络超时、429限流、网关5xx）时，采用指数退避（calculateDelay）自动恢复。
 * 4. 成本核算与缓存状态反馈（Token & Cache Tracking）：
 *    - 解析 stepUsage 并归一化，记录模型输入/输出/Prompt缓存命中情况，实时打印 Cache Hit 节约指标。
 * 5. 终止收敛判定（Termination Criteria）：
 *    - 满足以下任一条件时自动跳出循环：
 *      a) 步内无任何工具调用（LLM 给出最终自然语言回答）。
 *      b) 循环检测器判定死循环并触发熔断。
 *      c) 消耗 Token 超过全局预设上限（TOKEN_BUDGET）。
 *      d) 达到最大允许步数（MAX_STEPS）。
 *
 * @param model - AI SDK 兼容的模型实例
 * @param registry - 统一工具注册表
 * @param messages - 会话消息上下文数组（引用传递，循环内会不断追加新消息）
 * @param system - 最终组装完成的系统提示词
 * @param tracker - 可选的 Token 计量与成本跟踪器
 */
export async function agentLoop(
  model: any,
  registry: ToolRegistry,
  messages: ModelMessage[],
  system: string,
  tracker?: UsageTracker,
  options: ExecutionOptions = {},
) {
  let step = 0;
  let totalTokens = 0;
  // 每次进入 Agent 任务前重置死循环检测的历史记录
  resetHistory();

  while (step < MAX_STEPS) {
    step++;
    console.log(`\n--- Step ${step} ---`);

    let hasToolCall = false;
    let fullText = '';
    let shouldBreak = false;
    let lastToolCall: { name: string; input: unknown } | null = null;
    let stepResponse: any;
    let stepUsage: any;
    const calls = new Map<string, { name: string; input: unknown }>();

    // ── 单步执行与重试循环 ──────────────────────────
    for (let attempt = 1; ; attempt++) {
      try {
        const isGoogle = (process.env.MODEL_PROVIDER || '').toLowerCase() === 'google' || (process.env.MODEL_PROVIDER || '').toLowerCase() === 'gemini';

        // 发起流式模型请求
        const result = streamText({
          model,
          abortSignal: options.signal,
          system,
          tools: registry.toAISDKFormat(),
          messages,
          maxRetries: 0, // 由外层 retry 逻辑进行精细化退避控制
          providerOptions: !isGoogle ? { openai: { parallelToolCalls: true, store: true} } : undefined,
          onError: (error) => {
            console.error('流中的原始错误：', error);
          },
        });

        // 消费实时流式分块
        for await (const part of result.fullStream) {
          switch (part.type) {
            // 文本增量生成（即时打印打字机效果）
            case 'text-delta':
              options.emit?.({ type: 'text', text: part.text, step, attempt });
              process.stdout.write(part.text);
              fullText += part.text;
              break;

            // 工具调用发起
            case 'tool-call': {
              hasToolCall = true;
              lastToolCall = { name: part.toolName, input: part.input };
              calls.set(part.toolCallId, lastToolCall);
              options.emit?.({ type: 'tool-start', toolCallId: part.toolCallId, name: part.toolName, input: part.input, step, attempt });
              console.log(`  [调用: ${part.toolName}(${JSON.stringify(part.input)})]`);

              // ── 接入死循环/乒乓检测 ──
              const detection = detect(part.toolName, part.input);
              if (detection.stuck) {
                console.log(`  ${detection.message}`);
                if (detection.level === 'critical') {
                  shouldBreak = true; // 严重重复，直接熔断跳出
                } else {
                  // 轻度循环，注入系统反馈提醒模型换思路
                  messages.push({
                    role: 'user' as const,
                    content: `[系统提醒] ${detection.message}。请换一个思路解决问题，不要重复同样的操作。`,
                  });
                }
              }
              // 登记本次工具调用入参指纹
              recordCall(part.toolName, part.input);
              break;
            }

            // 工具调用执行结果返回
            case 'tool-result': {
              options.emit?.({ type: 'tool-result', toolCallId: part.toolCallId, name: part.toolName, output: part.output, step, attempt });
              const output = typeof part.output === 'string' ? part.output : JSON.stringify(part.output);
              const preview = output.length > 120 ? output.slice(0, 120) + '...' : output;
              console.log(`  [结果: ${part.toolName}] ${preview}`);
              const matchingCall = calls.get(part.toolCallId);
              if (matchingCall) {
                // 登记结果指纹，用于识别结果恒定不变的无进展重复
                recordResult(matchingCall.name, matchingCall.input, part.output);
              }
              break;
            }

            // 流式错误事件
            case 'error': {
              throw part.error;
            }
            case 'tool-error':
              options.emit?.({ type: 'tool-error', toolCallId: part.toolCallId, name: part.toolName, error: String(part.error), step, attempt });
              break;
          }
        }

        // 等待当前步完整响应元数据
        stepResponse = await result.response;
        stepUsage = await result.usage;
        break; // 成功完成当前 Step，跳出重试循环
      } catch (error) {
        // 异常诊断与重试判定
        if (NoOutputGeneratedError.isInstance(error)) {
          console.error('模型没有生成输出');
          console.error('底层原因：', error.cause);
        } else {
          console.error('请求失败：', error);
        }

        // 判断错误是否属于可重试类型（如 429、5xx、网络中断）
        if (attempt > MAX_RETRIES || !isRetryable(error as Error)) {
          throw error;
        }

        // 计算带抖动的指数退避时间
        const delay = calculateDelay(attempt);
        options.emit?.({ type: 'retry', step, attempt, delay });
        console.log(`  [重试] 第 ${attempt}/${MAX_RETRIES} 次，${delay}ms 后...`);
        await sleep(delay);

        // 重置单步临时状态
        hasToolCall = false;
        fullText = '';
        shouldBreak = false;
        lastToolCall = null;
      }
    }

    // 若触发关键熔断，立即终止 Agent Loop
    if (shouldBreak) {
      console.log('\n[循环检测触发，Agent 已停止]');
      break;
    }

    // 将本轮 Assistant 生成的内容及 Tool 执行消息推入上下文
    messages.push(...stepResponse!.messages);

    // ── Token 计量与 Cache Hit 状态展示 ───────────
    const norm = normalizeUsage(stepUsage);
    const stepRecord = tracker?.record(model?.modelId || 'mock-model', norm);
    totalTokens += norm.inputTokens + norm.outputTokens + norm.cacheReadTokens + norm.cacheWriteTokens;

    // 当有 Prompt Cache 命中或写入时，输出高亮提示
    if (stepRecord && (norm.cacheReadTokens > 0 || norm.cacheWriteTokens > 0)) {
      const tag = norm.cacheReadTokens > 0 ? `\x1b[38;5;36m✓ cache hit\x1b[0m` : `\x1b[38;5;220m✎ cache write\x1b[0m`;
      const detail = norm.cacheReadTokens > 0 ? `read ${norm.cacheReadTokens}` : `write ${norm.cacheWriteTokens}`;
      console.log(`  [${tag}] ${detail} tokens · 本步 $${stepRecord.cost.toFixed(5)}`);
    }

    // 预算监控与预警
    if (totalTokens > TOKEN_BUDGET * 0.9) {
      console.log(`  [Token] ${totalTokens}/${TOKEN_BUDGET} (${Math.round(totalTokens / TOKEN_BUDGET * 100)}%)`);
    }
    if (totalTokens > TOKEN_BUDGET) {
      console.log('\n[Token 预算耗尽]');
      break;
    }

    // 若模型未发起任何 Tool Call，说明已得出最终回答，终止多步循环
    if (!hasToolCall) {
      if (fullText) console.log();
      break;
    }

    console.log('  → 继续下一步...');
  }

  if (step >= MAX_STEPS) {
    console.log('\n[达到最大步数]');
  }
}
