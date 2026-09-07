/**
 * Hook 执行动作决策：
 * - 'allow': 放行当前工具调用，继续交由下一个 Hook 或底层工具执行。
 * - 'block': 熔断并拦截当前工具调用，终止后续流程，直接返回拦截原因给模型。
 * - 'modify': 篡改/重写数据，对入参（modifiedInput）或出参（modifiedOutput）进行脱敏、净化或转换。
 */
export type HookAction = 'allow' | 'block' | 'modify';

/**
 * Hook 执行返回值结构体
 */
export interface HookResult {
  /** 本次 Hook 的拦截或流转决策 */
  action: HookAction;
  /** 拦截时的明确错误或告警原因（在终端打印并反馈给模型） */
  reason?: string;
  /** 预处理阶段篡改重写后的新入参（在 action === 'modify' 时生效） */
  modifiedInput?: unknown;
  /** 后处理阶段篡改重写后的新出参（在 action === 'modify' 时生效） */
  modifiedOutput?: unknown;
}

/**
 * 工具前置拦截钩子函数（PreToolHook）。
 *
 * 在工具真正执行之前触发，可用于：权限二次鉴权、输入参数白名单校验、防越权注入、参数自动修剪与补充。
 */
export type PreToolHook = (toolName: string, input: unknown) => HookResult | Promise<HookResult>;

/**
 * 工具后置拦截钩子函数（PostToolHook）。
 *
 * 在工具成功执行后触发，可用于：敏感数据脱敏（如过滤密码、Token、身份证号）、审计日志持久化、输出截断与二次加工。
 */
export type PostToolHook = (toolName: string, input: unknown, output: unknown) => HookResult | Promise<HookResult>;

/**
 * 工具安全拦截与生命周期切面管道（HookPipeline）。
 *
 * 架构定位：
 * 采用洋葱模型/责任链模式（Chain of Responsibility），在 Agent 工具调用（Tool Execution）
 * 的核心前后提供非侵入式的“预处理前置钩子（Pre Hooks）”与“后处理后置钩子（Post Hooks）”。
 */
export class HookPipeline {
  /** 注册的前置切面处理器集合 */
  private preHooks: Array<{ name: string; fn: PreToolHook }> = [];
  /** 注册的后置切面处理器集合 */
  private postHooks: Array<{ name: string; fn: PostToolHook }> = [];

  /**
   * 注册前置钩子
   * @param name 钩子名称（如 'path-traversal-guard', 'param-sanitizer'）
   * @param fn 前置拦截回调函数
   */
  registerPre(name: string, fn: PreToolHook): void {
    this.preHooks.push({ name, fn });
  }

  /**
   * 注册后置钩子
   * @param name 钩子名称（如 'secret-masker', 'audit-logger'）
   * @param fn 后置拦截回调函数
   */
  registerPost(name: string, fn: PostToolHook): void {
    this.postHooks.push({ name, fn });
  }

  /**
   * 按注册顺序链式串行执行所有前置钩子。
   *
   * 特性：
   * 1. 短路机制：一旦任意 Hook 返回 'block'，立即熔断后续所有 Hook 及工具本身；
   * 2. 管道流水线（Pipeline）：前一个 Hook 返回的 modifiedInput 会无缝传递给后续 Hook 作为新输入。
   *
   * @param toolName 即将调用的工具名
   * @param input 原始或上一级传递的入参
   * @returns 最终聚合的判定结果（含可能被修改的 input）
   */
  async runPre(toolName: string, input: unknown): Promise<HookResult> {
    let currentInput = input;
    for (const hook of this.preHooks) {
      try {
        const result = await hook.fn(toolName, currentInput);

        // 1. 触发拦截熔断
        if (result.action === 'block') {
          console.log(`  [hook:${hook.name}] 拦截 ${toolName}: ${result.reason}`);
          return result;
        }

        // 2. 触发入参链式修改
        if (result.action === 'modify' && result.modifiedInput !== undefined) {
          currentInput = result.modifiedInput;
        }
      } catch (err) {
        // 单个 Hook 异常不应导致主进程崩溃，记录日志并优雅降级
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  [hook:${hook.name}] pre 异常: ${msg}`);
      }
    }
    return { action: 'allow', modifiedInput: currentInput };
  }

  /**
   * 按注册顺序链式串行执行所有后置钩子。
   *
   * 特性：
   * 1. 对工具执行返回的 output 进行链式脱敏或增强；
   * 2. 前一个 Hook 返回的 modifiedOutput 会作为下一个 Hook 的当前 output。
   *
   * @param toolName 已执行完成的工具名
   * @param input 最终传入执行工具的参数
   * @param output 工具执行产出的原始返回值
   * @returns 最终聚合处理后的结果（含最终的 modifiedOutput）
   */
  async runPost(toolName: string, input: unknown, output: unknown): Promise<HookResult> {
    let currentOutput = output;
    for (const hook of this.postHooks) {
      try {
        const result = await hook.fn(toolName, input, currentOutput);

        // 触发出参链式篡改/脱敏
        if (result.action === 'modify' && result.modifiedOutput !== undefined) {
          currentOutput = result.modifiedOutput;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  [hook:${hook.name}] post 异常: ${msg}`);
      }
    }
    return { action: 'allow', modifiedOutput: currentOutput };
  }

  /**
   * 查询并列出当前管道中已注册的前置与后置 Hook 清单
   */
  list(): { pre: string[]; post: string[] } {
    return {
      pre: this.preHooks.map((h) => h.name),
      post: this.postHooks.map((h) => h.name),
    };
  }
}

