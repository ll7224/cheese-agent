import { type ModelMessage, streamText } from 'ai';
import type { ToolRegistry } from '../tools/registry.js';
import type { SubAgentRegistry } from './registry.js';
import type { SpawnRequest } from './types.js';

/**
 * 子 Agent 执行上下文依赖容器
 */
export interface SpawnContext {
  /** 模型实例 */
  model: any;
  /** 全局工具注册中心 */
  registry: ToolRegistry;
  /** 子 Agent 运行状态注册管理中枢 */
  agentRegistry: SubAgentRegistry;
  /** 动态构建系统 Prompt 的工厂函数 */
  buildSystem: () => string;
  /** 当前父 Agent 的嵌套深度（顶级为 0） */
  currentDepth: number;
}

/** 单个子 Agent 最大允许进行的推理步数（Step 上限） */
const SUB_AGENT_MAX_STEPS = 10;
/** 子 Agent 内部必须剔除的递归派生工具（防止子 Agent 自身继续 spawn 子 Agent 造成失控） */
const EXCLUDED_TOOLS = new Set(['spawn_agent']);

/** 控制台多彩终端色彩高亮映射表 */
const AGENT_COLORS = [
  '\x1b[36m', // 青色 cyan
  '\x1b[33m', // 黄色 yellow
  '\x1b[35m', // 洋红 magenta
  '\x1b[32m', // 绿色 green
  '\x1b[34m', // 蓝色 blue
];
const RESET = '\x1b[0m';

/**
 * 格式化输出带有色彩标签的子 Agent 标识，如 `[Agent-1:sub-1-8f2a]`
 */
function agentTag(index: number, runId: string): string {
  const color = AGENT_COLORS[index % AGENT_COLORS.length];
  return `${color}[Agent-${index + 1}:${runId}]${RESET}`;
}

/**
 * 派发并执行单个子 Agent（核心实现）。
 *
 * 核心执行流程：
 * 1. 深度与并发配额准入校验（canSpawn）；
 * 2. 状态机初始化与彩色日志记录；
 * 3. 构造专属独立的 Messages 上下文与定制化的 System Prompt（注入子 Agent 任务指令）；
 * 4. 驱动 AI SDK streamText 进行多步 Tool Calling 推理循环；
 * 5. 步数逼近上限（Step === maxSteps）时强制切换为 `toolChoice: 'none'` 并诱导大模型输出总结结论；
 * 6. 支持超时控制（AbortController）与优雅部分结果提取，执行完毕后更新 Registry 状态。
 *
 * @param request 任务请求描述
 * @param ctx 执行上下文依赖
 * @param index 任务序号，用于终端颜色区分
 * @returns 子 Agent 产出的最终文本摘要
 */
export async function spawnAgent(
  request: SpawnRequest,
  ctx: SpawnContext,
  index = 0,
): Promise<string> {
  // 1. 准入与限流熔断判定
  const { ok, reason } = ctx.agentRegistry.canSpawn(ctx.currentDepth);
  if (!ok) return `[spawn] 拒绝: ${reason}`;

  // 2. 状态机登记
  const runId = ctx.agentRegistry.generateId();
  const tag = agentTag(index, runId);
  const run = {
    id: runId,
    task: request.task,
    status: 'running' as const,
    depth: ctx.currentDepth + 1,
    startedAt: new Date().toISOString(),
  };
  ctx.agentRegistry.register(run);

  const timeout = request.timeout || 60000;
  const maxSteps = 30;
  const ac = new AbortController();
  console.log(`  ${tag} 启动: ${request.task.slice(0, 50)}`);

  // 3. 组装子 Agent 独立上下文与针对性系统 Prompt
  const messages: ModelMessage[] = [
    { role: 'user', content: request.task },
  ];

  try {
    const system =
      ctx.buildSystem() +
      '\n\n[子 Agent 模式] 你是一个被派出去执行具体任务的子 Agent。直接完成任务并输出结论，保持简洁。' +
      '\n当你需要同时获取多个独立信息时（比如读多个文件、搜多个关键词），尽可能在一次回复中并行调用多个工具，不要一个个串行调。';

    // 获取排除 spawn_agent 之后的工具集（解除并发读写锁限制）
    const tools = ctx.registry.toAISDKFormatUnlocked(EXCLUDED_TOOLS);
    const timer = setTimeout(() => ac.abort(), timeout);

    try {
      let step = 0;
      // 4. 多轮次推理循环
      while (step < maxSteps) {
        step++;
        const isLastStep = step === maxSteps;
        console.log(`  ${tag} Step ${step}/${maxSteps}${isLastStep ? ' (总结)' : ''}`);

        // 达到最大步数时，强制要求模型总结输出，禁止继续调用工具
        if (isLastStep) {
          messages.push({
            role: 'user',
            content: '你已经收集了足够的信息。请直接输出文字总结，不要再调用任何工具。',
          });
        }

        const result = streamText({
          model: ctx.model,
          system,
          tools,
          toolChoice: isLastStep ? 'none' : 'auto',
          messages,
          maxRetries: 0,
          abortSignal: ac.signal,
          providerOptions: { openai: { parallelToolCalls: true } },
          onError: () => {},
        });

        let hasToolCall = false;
        for await (const part of result.fullStream) {
          if (part.type === 'tool-call') {
            hasToolCall = true;
            const argsPreview = JSON.stringify(part.input).slice(0, 80);
            console.log(`  ${tag} 调用 ${part.toolName}(${argsPreview})`);
          }
        }

        const response = await result.response;
        messages.push(...response.messages);

        // 模型没有再发起工具调用，说明已经得出最终结论，退出循环
        if (!hasToolCall) break;
      }
    } finally {
      clearTimeout(timer);
    }

    // 5. 提取最后的 Assistant 回复
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    let result = '(无输出)';
    if (lastAssistant) {
      if (typeof lastAssistant.content === 'string') {
        result = lastAssistant.content;
      } else if (Array.isArray(lastAssistant.content)) {
        result =
          lastAssistant.content
            .filter((p: any) => p.type === 'text')
            .map((p: any) => p.text)
            .join('') || '(无输出)';
      }
    }

    // 6. 标记成功
    ctx.agentRegistry.complete(runId, result);
    console.log(`  ${tag} 完成 ✓ (${result.length} 字符)`);
    return result;
  } catch (err: any) {
    const isAbort = err.name === 'AbortError' || ac.signal.aborted;
    const errorMsg = isAbort
      ? `执行超时 (${timeout / 1000}s)`
      : err.message || String(err);
    ctx.agentRegistry.fail(runId, errorMsg);
    console.log(`  ${tag} ${isAbort ? '超时' : '失败'} ✗: ${errorMsg}`);

    // 超时降级：尝试抓取超时前已生成的文本片段返回，避免完全丢失有用信息
    if (isAbort) {
      const partial = [...messages].reverse().find((m) => m.role === 'assistant');
      if (partial) {
        const text =
          typeof partial.content === 'string'
            ? partial.content
            : Array.isArray(partial.content)
              ? partial.content
                  .filter((p: any) => p.type === 'text')
                  .map((p: any) => p.text)
                  .join('')
              : '';
        if (text) return `[部分结果] ${text}`;
      }
    }
    return `[sub-agent 执行失败] ${errorMsg}`;
  }
}

/**
 * 批量并行派发多个子 Agent（Fan-out 并行探索模式）。
 *
 * 核心机制：
 * 1. 容量感知切片：根据当前系统剩余并发配额（maxConcurrent - activeCount）进行切片；
 * 2. 优雅降级：若超出并发限制，前 N 个执行，剩余的标记并返回拒绝提示，杜绝资源雪崩；
 * 3. 并发聚合：通过 Promise.all 触发并行推理，最终聚合每个子 Agent 的返回摘要。
 *
 * @param requests 任务请求数组
 * @param ctx 上下文容器
 * @returns 各子任务的结果数组
 */
export async function spawnParallel(
  requests: SpawnRequest[],
  ctx: SpawnContext,
): Promise<Array<{ task: string; result: string }>> {
  const maxConcurrent = ctx.agentRegistry.getConfig().maxConcurrent;
  const activeCount = ctx.agentRegistry.getActiveRuns().length;
  const available = maxConcurrent - activeCount;

  // 1. 无可用并发配额
  if (available <= 0) {
    return requests.map((r) => ({
      task: r.task,
      result: `[spawn] 拒绝: 已达最大并发数 ${maxConcurrent}`,
    }));
  }

  // 2. 按可用容量切分可执行任务与被拒任务
  const toRun = requests.slice(0, available);
  const rejected = requests.slice(available);
  if (rejected.length > 0) {
    console.log(
      `  ⚠ 请求 ${requests.length} 个子 Agent，但最大并发为 ${maxConcurrent}，只执行前 ${toRun.length} 个`,
    );
  }

  console.log(`\n  ┌─ 派发 ${toRun.length} 个子 Agent 并行执行 ─┐`);
  // 3. 并行拉起所有子 Agent 执行
  const results = await Promise.all(
    toRun.map(async (req, i) => {
      const result = await spawnAgent(req, ctx, i);
      return { task: req.task, result };
    }),
  );

  // 4. 追加被截断拒绝的任务项提示
  for (const r of rejected) {
    results.push({
      task: r.task,
      result: `[spawn] 拒绝: 超出最大并发数 ${maxConcurrent}，本次未执行`,
    });
  }
  console.log(`  └─ 全部完成 (${results.length}/${requests.length}) ─┘\n`);
  return results;
}
