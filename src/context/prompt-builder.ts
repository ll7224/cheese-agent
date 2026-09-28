export interface PromptContext {
    toolCount: number;
    deferredToolSummary: string;
    sessionMessageCount: number;
    sessionId: string;
    modelName?: string;
    provider?: string;
}
  
  type PipeFn = (ctx: PromptContext) => string | null;
  
  export class PromptBuilder {
    private pipes: Array<{ name: string; fn: PipeFn }> = [];
  
    pipe(name: string, fn: PipeFn): this {
      this.pipes.push({ name, fn });
      return this;
    }
  
    build(ctx: PromptContext): string {
      const sections: string[] = [];
  
      for (const { fn } of this.pipes) {
        const result = fn(ctx);
        if (result !== null) {
          sections.push(result);
        }
      }
  
      return sections.join('\n\n');
    }
  
    debug(ctx: PromptContext): void {
      console.log('\n=== Prompt Pipe Debug ===');
      for (const { name, fn } of this.pipes) {
        const result = fn(ctx);
        const status = result !== null ? `[ON] ${result.length} chars` : '[OFF]';
        console.log(`  ${name}: ${status}`);
      }
      console.log('========================\n');
    }
  }
  
  // ── 预定义的 Pipe ────────────────────────────────
  
  export function coreRules(): PipeFn {
    return () => `你是 Cheese Agent，一个有工具调用能力的 AI 助手。
  你的行为准则：
  - 先读文件再修改，不要凭记忆编辑
  - 不要加没被要求的功能
  - 工具调用失败时，换一个思路而不是重复同样的操作
  - 回答要简洁直接`;
  }
  
  export function toolGuide(): PipeFn {
    return (ctx) => {
      if (ctx.toolCount === 0) return null;
      return `你有 ${ctx.toolCount} 个工具可用。需要操作本地文件时使用内置工具，需要访问外部服务时使用 MCP 工具。`;
    };
  }
  
  export function deferredTools(): PipeFn {
    return (ctx) => {
      if (!ctx.deferredToolSummary) return null;
      return `如果你需要的工具不在当前列表中，使用 tool_search 工具搜索。${ctx.deferredToolSummary}`;
    };
  }
  
  export function modelIdentity(): PipeFn {
  return (ctx) => {
    if (!ctx.modelName) return null;
    return `[模型身份与环境说明]
当前底层为你提供算力与推理的模型是：${ctx.modelName}（Provider: ${ctx.provider || 'default'}）。
当用户询问你是哪个模型、或者询问你的模型版本/底层模型时，请准确、如实告知用户当前运行的底层模型为 ${ctx.modelName}。`;
  };
}

export function sessionContext(): PipeFn {
    return (ctx) => {
      if (ctx.sessionMessageCount === 0) return null;
      return `[会话信息] 当前会话 ${ctx.sessionId}，已有 ${ctx.sessionMessageCount} 条历史消息。`;
    };
  }
  