import { streamText, type ModelMessage, NoOutputGeneratedError } from 'ai';
import { ToolRegistry } from '../tools/registry.js';
import { detect, recordCall, recordResult, resetHistory } from './loop-detection.js';
import { isRetryable, calculateDelay } from './retry.js';
import { type UsageTracker, normalizeUsage } from '../usage/tracker.js';
import type { ExecutionOptions } from '../runtime/events.js';
import { stopExecution } from './termination.js';
import { DEFAULT_TOKEN_BUDGET } from './limits.js';
import { InvestigationProgress } from './investigation-progress.js';

/**
 * Agent 核心运行循环配置常量
 *
 * MAX_STEPS: 单次交互允许的最大推理步数（防止多轮工具调用无限发散）
 * MAX_RETRIES: 单步调用 LLM 发生网络/临时错误时的最大重试次数
 * Token 预算通过 ExecutionOptions 配置，默认值见 limits.ts。
 */
const MAX_STEPS = 15;
const MAX_RETRIES = 5;

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
 *      c) 累计输入与输出 Token 达到该次循环的预算。
 *      d) 达到最大允许步数（MAX_STEPS）。
 *
 * @param model - AI SDK 兼容的模型实例
 * @param registry - 统一工具注册表
 * @param messages - 会话消息上下文数组（引用传递，循环内会不断追加新消息）
 * @param system - 最终组装完成的系统提示词
 * @param tracker - 可选的 Token 计量与成本跟踪器
 */
/**
 * 过滤与提取流式文本中的 <think>...</think> 标签
 */
function createThinkingFilter(
  onText: (text: string) => void,
  onReasoning: (text: string) => void
) {
  let inThink = false;
  let buffer = '';

  return {
    push(chunk: string) {
      buffer += chunk;
      while (buffer.length > 0) {
        if (!inThink) {
          const thinkIndex = buffer.indexOf('<think>');
          if (thinkIndex !== -1) {
            const before = buffer.slice(0, thinkIndex);
            if (before) onText(before);
            inThink = true;
            buffer = buffer.slice(thinkIndex + 7);
          } else {
            const partial = buffer.match(/<t?(h?(i?(n?(k)?)?)?)?$/);
            if (partial && partial.index !== undefined && buffer.length - partial.index < 7) {
              const safe = buffer.slice(0, partial.index);
              if (safe) onText(safe);
              buffer = buffer.slice(partial.index);
              break;
            } else {
              onText(buffer);
              buffer = '';
            }
          }
        } else {
          const endThinkIndex = buffer.indexOf('</think>');
          if (endThinkIndex !== -1) {
            const before = buffer.slice(0, endThinkIndex);
            if (before) onReasoning(before);
            inThink = false;
            buffer = buffer.slice(endThinkIndex + 8);
          } else {
            const partial = buffer.match(/<\/?t?(h?(i?(n?(k)?)?)?)?$/);
            if (partial && partial.index !== undefined && buffer.length - partial.index < 8) {
              const safe = buffer.slice(0, partial.index);
              if (safe) onReasoning(safe);
              buffer = buffer.slice(partial.index);
              break;
            } else {
              onReasoning(buffer);
              buffer = '';
            }
          }
        }
      }
    },
    flush() {
      if (buffer) {
        if (inThink) onReasoning(buffer);
        else onText(buffer);
        buffer = '';
      }
    }
  };
}

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
  const maxSteps = options.maxSteps || MAX_STEPS;
  const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0) throw new Error('tokenBudget 必须为正整数');
  // 每次进入 Agent 任务前重置死循环检测的历史记录
  resetHistory();
  const investigation = new InvestigationProgress();

  while (step < maxSteps) {
    options.signal?.throwIfAborted();
    step++;
    console.log(`\n--- Step ${step} ---`);

    let hasToolCall = false;
    let fullText = '';
    let shouldBreak = false;
    let loopStopMessage = '';
    let lastToolCall: { name: string; input: unknown } | null = null;
    let stepResponse: any;
    let stepUsage: any;
    let finishReason: string | undefined;
    const calls = new Map<string, { name: string; input: unknown }>();
    const reminders: Array<{ reason: string; message: string }> = [];
    const toolResults: Array<{ name: string; output: unknown }> = [];
    let toolFailed = false;

    // ── 单步执行与重试循环 ──────────────────────────
    for (let attempt = 1; ; attempt++) {
      try {
        const isGoogle = String(model.provider || '').startsWith('google');

        // 发起流式模型请求
        const result = streamText({
          model,
          abortSignal: options.signal,
          system,
          tools: registry.toAISDKFormat(options.signal),
          messages,
          maxRetries: 0, // 由外层 retry 逻辑进行精细化退避控制
          providerOptions: !isGoogle ? { openai: { parallelToolCalls: true, store: true} } : undefined,
          onError: (error) => {
            console.error('流中的原始错误：', error);
          },
        });

        const thinkingFilter = createThinkingFilter(
          (text) => {
            options.emit?.({ type: 'text', text, step, attempt });
            if (!options.emit) process.stdout.write(text);
            fullText += text;
          },
          (reasoningText) => {
            options.emit?.({ type: 'reasoning', text: reasoningText, step, attempt });
          }
        );

        // 消费实时流式分块
        for await (const part of result.fullStream) {
          switch (part.type) {
            // 推理过程事件处理（支持 OpenAI o1/o3、DeepSeek-R1、Gemini Thinking 等）
            case 'reasoning-start':
              options.emit?.({ type: 'reasoning-start', step, attempt });
              break;

            case 'reasoning-delta':
            case 'reasoning' as any: {
              const text = (part as any).text || (part as any).textDelta || (part as any).delta || '';
              if (text) {
                options.emit?.({ type: 'reasoning', text, step, attempt });
              }
              break;
            }

            case 'reasoning-end':
              options.emit?.({ type: 'reasoning-end', step, attempt });
              break;

            // 文本增量生成（即时打印打字机效果，内置 <think> 标签过滤拦截）
            case 'text-delta':
              thinkingFilter.push(part.text);
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
                  loopStopMessage = detection.message;
                } else {
                  // Append feedback after the complete assistant/tool exchange.
                  reminders.push({
                    reason: 'repeated-call',
                    message: `${detection.message}。请换一个思路解决问题，不要重复同样的操作。`,
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
                toolResults.push({ name: matchingCall.name, output: part.output });
              }
              break;
            }

            // 流式错误事件
            case 'error': {
              throw part.error;
            }
            case 'tool-error':
              toolFailed = true;
              options.emit?.({ type: 'tool-error', toolCallId: part.toolCallId, name: part.toolName, error: String(part.error), step, attempt });
              break;
          }
        }

        thinkingFilter.flush();

        // 等待当前步完整响应元数据
        stepResponse = await result.response;
        stepUsage = await result.usage;
        finishReason = await result.finishReason;

        // 若 assistant message 中包含 <think> 标签，提纯内容并挂载 reasoning
        if (stepResponse?.messages) {
          for (const msg of stepResponse.messages) {
            if (msg.role === 'assistant') {
              if (typeof msg.content === 'string') {
                const match = msg.content.match(/<think>([\s\S]*?)<\/think>/);
                if (match) {
                  (msg as any).reasoning = match[1].trim();
                  msg.content = msg.content.replace(/<think>[\s\S]*?<\/think>/, '').trim();
                }
              } else if (Array.isArray(msg.content)) {
                for (const item of msg.content) {
                  if (item.type === 'text' && typeof item.text === 'string') {
                    const match = item.text.match(/<think>([\s\S]*?)<\/think>/);
                    if (match) {
                      (msg as any).reasoning = ((msg as any).reasoning ? (msg as any).reasoning + '\n' : '') + match[1].trim();
                      item.text = item.text.replace(/<think>[\s\S]*?<\/think>/, '').trim();
                    }
                  }
                }
              }
            }
          }
        }
        break; // 成功完成当前 Step，跳出重试循环
      } catch (error) {
        options.signal?.throwIfAborted();
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
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(options.signal?.reason); };
          const timer = setTimeout(() => { options.signal?.removeEventListener('abort', abort); resolve(); }, delay);
          options.signal?.addEventListener('abort', abort, { once: true });
        });

        // 重置单步临时状态
        hasToolCall = false;
        fullText = '';
        shouldBreak = false;
        loopStopMessage = '';
        lastToolCall = null;
        calls.clear();
        reminders.length = 0;
        toolResults.length = 0;
        toolFailed = false;
      }
    }

    // 将本轮 Assistant 生成的内容及 Tool 执行消息推入上下文
    messages.push(...stepResponse!.messages);

    // ── Token 计量与 Cache Hit 状态展示 ───────────
    const norm = normalizeUsage(stepUsage);
    const stepRecord = tracker?.record(model?.modelId || 'mock-model', norm);
    // SDK totals already include cached input; do not count cache reads twice.
    totalTokens += stepUsage?.totalTokens ?? ((stepUsage?.inputTokens ?? 0) + (stepUsage?.outputTokens ?? 0));
    options.emit?.({ type: 'step-finish', step, finishReason, usage: {
      input: stepUsage?.inputTokens ?? null, output: stepUsage?.outputTokens ?? null,
      total: stepUsage?.totalTokens ?? null,
    } });

    if (shouldBreak) {
      stopExecution(options, 'loop-detected', `${loopStopMessage}。本次任务未完成，请查看最后的工具结果后调整指令。`, step);
    }
    if (finishReason === 'length') {
      stopExecution(options, 'model-length', '模型回复达到输出长度限制，任务未完成；已有输出和执行记录已保留。', step);
    }
    if (finishReason === 'content-filter' || finishReason === 'error') {
      stopExecution(options, finishReason === 'error' ? 'model-error' : 'content-filter',
        finishReason === 'error' ? '模型以错误状态结束，未完成本次任务。' : '模型因内容过滤停止，未完成本次任务。', step);
    }

    // 当有 Prompt Cache 命中或写入时，输出高亮提示
    if (stepRecord && (norm.cacheReadTokens > 0 || norm.cacheWriteTokens > 0)) {
      const tag = norm.cacheReadTokens > 0 ? `\x1b[38;5;36m✓ cache hit\x1b[0m` : `\x1b[38;5;220m✎ cache write\x1b[0m`;
      const detail = norm.cacheReadTokens > 0 ? `read ${norm.cacheReadTokens}` : `write ${norm.cacheWriteTokens}`;
      console.log(`  [${tag}] ${detail} tokens · 本步 $${stepRecord.cost.toFixed(5)}`);
    }

    // A normal final answer needs no further step, even when its usage crosses the budget.
    if (!hasToolCall) {
      if (!fullText.trim()) {
        stopExecution(options, 'empty-response', '模型结束了本轮响应，但没有返回最终答复。请查看执行日志中的最后一步后决定是否继续。', step, { finishReason });
      }
      console.log();
      return;
    }

    // 预算监控与预警
    if (totalTokens > tokenBudget * 0.9) {
      console.log(`  [Token] ${totalTokens}/${tokenBudget} (${Math.round(totalTokens / tokenBudget * 100)}%)`);
    }
    if (totalTokens >= tokenBudget) {
      stopExecution(options, 'token-budget', `本次运行已达到 Token 预算上限（${tokenBudget.toLocaleString('en-US')}），累计已用 ${totalTokens.toLocaleString('en-US')}。任务已停止，未确认完成。请查看执行日志，检查最后一步后再决定继续或调整预算。`, step, { used: totalTokens, budget: tokenBudget });
    }

    if (step < maxSteps) {
      // A modifying/unknown tool may change the evidence, even when it shares a
      // step with reads. Only completed, wholly read-only steps feed the tracker.
      if (toolFailed || [...calls.values()].some(call => registry.get(call.name)?.isReadOnly !== true)) {
        investigation.observe(undefined, undefined);
      } else {
        for (const result of toolResults) {
          if (investigation.observe(registry.get(result.name), result.output)) {
            reminders.push({
              reason: 'repeated-evidence',
              message: '近期多次只读调用返回了已见结果，可能正在重复取证。请先整理已知证据、当前假设和仍缺少的信息；接下来的检查应能区分原因。证据足够时按任务授权修复并验证；无法继续时说明具体阻塞并交付已有发现，不要只更换关键词重复搜索，也不要为结束调查而盲目修改。',
            });
          }
        }
      }
      for (const reminder of reminders) {
        messages.push({ role: 'user', content: `[系统提醒] ${reminder.message}` });
        options.emit?.({ type: 'execution-warning', ...reminder, step });
      }
    }

    console.log('  → 继续下一步...');
  }

  if (step >= maxSteps) {
    stopExecution(options, 'step-limit', `已达到本次运行的 ${maxSteps} 步上限，任务已停止，尚未生成最终答复。已有执行记录已保留，请检查后再决定是否继续。`, step, { maxSteps });
  }
}
