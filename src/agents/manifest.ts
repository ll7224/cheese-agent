import { z } from 'zod';

/**
 * 垂直领域 Agent 清单（agent.json）数据契约 Schema 定义
 */
export const AgentManifestSchema = z.object({
  /** 唯一标识符（由英文字母、数字、短横线、下划线组成），通常对应目录名 */
  id: z.string().min(1).regex(/^[a-z0-9-_]+$/),
  /** 领域 Agent 展示名称，例如："代码审计专家"、"法务合规顾问" */
  name: z.string().min(1),
  /** 该 Agent 的核心功能与定位简要描述 */
  description: z.string().default(''),
  /** 视觉头像（支持 Emoji 或图片 URL，默认 🤖） */
  avatar: z.string().default('🤖'),
  /** 内联系统提示词（System Prompt） */
  systemPrompt: z.string().optional(),
  /** 外部系统提示词文件路径（相对 agent.json 所在目录，例如: "PROMPT.md"） */
  promptFile: z.string().optional(),
  /** 推荐的大语言模型偏好配置（可选） */
  modelPreference: z
    .object({
      provider: z.string().optional(),
      name: z.string().optional(),
    })
    .optional(),
  /**
   * 显式允许该 Agent 调用的非基线工具清单（白名单机制）。
   * 基础只读工具（文件只读浏览、记忆存取、知识库问答）默认开放；
   * 高危或专业工具（如 "bash"、"file_write"、"spawn_agent" 或 "mcp:xxx"）必须在此显式声明。
   * 特殊通配符 ["*"] 表示拥有所有已注册工具权限（如通用助手）。
   */
  tools: z.array(z.string()).default([]),
  /** 默认绑定的领域 SOP 技能名称列表（对应 .skills/ 下的名称） */
  skills: z.array(z.string()).default([]),
  /** 绑定的知识库 Collection ID 列表（联合检索范围） */
  knowledge: z.array(z.string()).default([]),
  /** 单次任务执行最大步数保护上限，默认 30 */
  maxSteps: z.number().int().positive().default(30),
});

export type AgentManifest = z.infer<typeof AgentManifestSchema>;

/**
 * 内存中已解析完成的 Agent 运行时实体定义
 */
export interface AgentDefinition extends AgentManifest {
  /** 组装后的完整系统提示词（合并 systemPrompt 与 promptFile 读取的内容） */
  fullPrompt: string;
  /** 该 Agent 所在的物理目录绝对路径（内置 Agent 为 'builtin'） */
  dirPath: string;
  /** Agent 来源类型：工作区局部、全局通用或系统内置 */
  source: 'workspace' | 'global' | 'builtin';
}
