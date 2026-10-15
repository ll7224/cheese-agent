import type { PostToolHook, HookResult } from '../security/hooks.js';
import type { KnowledgeService } from './service.js';
import type { KnowledgeContext } from './types.js';

export interface JitGuardrailOptions {
  knowledgeService: KnowledgeService;
  getContext: () => KnowledgeContext;
  /** 是否开启同一会话内相同作用域去重（默认 true） */
  deduplicatePerSession?: boolean;
}

/**
 * 提取文件操作类工具入参中的文件/目录路径
 */
export function extractTargetFilePath(toolName: string, input: any): string | null {
  if (!input || typeof input !== 'object') return null;

  if (toolName === 'read_file' || toolName === 'write_file' || toolName === 'edit_file') {
    return String(input.path || input.filepath || input.file_path || '').trim() || null;
  }

  if (toolName === 'list_files') {
    return String(input.path || input.dir || input.directory || '').trim() || null;
  }

  if (toolName === 'bash' && input.command) {
    // 针对显式包含路径的简单文件读取/编辑类命令进行辅助探测
    const match = String(input.command).match(/(?:cat|vim|nano|head|tail|less|touch)\s+([^\s;&|]+)/);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  return null;
}

/**
 * 构造 JIT 触碰拦截后置切面钩子 (PostToolHook)
 *
 * 【工作机制】：
 * 1. 拦截目标工具对本地文件/模块路径的读取或改动；
 * 2. 依据触碰路径向知识中心查询适用于该路径的已生效守则与避坑备忘 (findGuardrails)；
 * 3. 将格式化后的防御性契约提示框 `[PROJECT MEMO]` 追加至工具输出；
 * 4. 内置防刷屏会话去重机制，同一作用域在单次任务/会话周期内首次触碰时注入。
 */
export function createJitGuardrailHook(options: JitGuardrailOptions): {
  hook: PostToolHook;
  resetSession: () => void;
  touchedScopes: Set<string>;
} {
  const touchedScopes = new Set<string>();

  const resetSession = () => {
    touchedScopes.clear();
  };

  const hook: PostToolHook = async (toolName: string, input: unknown, output: unknown): Promise<HookResult> => {
    const rawPath = extractTargetFilePath(toolName, input);
    if (!rawPath) {
      return { action: 'allow' };
    }

    // 格式化相对路径
    const normalizedPath = rawPath
      .replace(/^\.\//, '')
      .replace(/\\/g, '/');

    try {
      const ctx = options.getContext();
      const items = options.knowledgeService.getGuardrails(ctx, normalizedPath);
      if (!items || items.length === 0) {
        return { action: 'allow' };
      }

      // 如果启用了去重，检查这些条目所属的适用作用域是否全部已经提示过
      if (options.deduplicatePerSession !== false) {
        const unnotifiedItems = items.filter((item) => {
          const scopeKey = item.applicability || '*';
          return !touchedScopes.has(scopeKey);
        });

        if (unnotifiedItems.length === 0) {
          return { action: 'allow' };
        }

        // 登记本次已提示的作用域
        for (const item of unnotifiedItems) {
          const scopeKey = item.applicability || '*';
          touchedScopes.add(scopeKey);
        }
      }

      const memo = options.knowledgeService.getJitGuardrails(ctx, normalizedPath);
      if (!memo) {
        return { action: 'allow' };
      }

      const originalText = typeof output === 'string' ? output : JSON.stringify(output);
      const modifiedOutput = `${originalText}\n\n${memo}`;

      return {
        action: 'modify',
        modifiedOutput,
      };
    } catch {
      return { action: 'allow' };
    }
  };

  return {
    hook,
    resetSession,
    touchedScopes,
  };
}
