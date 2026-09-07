import { z } from 'zod';

export const ModelConfigSchema = z.object({
  provider: z.enum(['dashscope', 'openai', 'google', 'gemini', 'custom']).or(z.string()).default('dashscope'),
  name: z.string().default('qwen-plus-latest'),
  baseURL: z.string().default('https://dashscope.aliyuncs.com/compatible-mode/v1'),
  apiKey: z.string().default(''),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const PluginConfigSchema = z.object({
  name: z.string(),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).default({}),
});

export const FeishuChannelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  appId: z.string().default(''),
  appSecret: z.string().default(''),
  port: z.number().default(3000),
});

export const ChannelConfigSchema = z.object({
  feishu: FeishuChannelConfigSchema.default({
    enabled: false,
    appId: '',
    appSecret: '',
    port: 3000,
  }),
});

export const AgentConfigSchema = z.object({
  maxSpawnDepth: z.number().min(0).max(5).default(1),
  maxConcurrent: z.number().min(1).max(10).default(3),
  defaultTimeout: z.number().default(60000),
});

export const SecurityConfigSchema = z.object({
  defaultRole: z.string().default('developer'),
  auditLog: z.boolean().default(true),
  bashTimestamp: z.boolean().default(true),
});

export const MemoryConfigSchema = z.object({
  dataDir: z.string().default('.'),
});

export const RagConfigSchema = z.object({
  enabled: z.boolean().default(true),
  docsDir: z.string().default('docs'),
  provider: z.string().default('dashscope'),
  model: z.string().default('qwen3.7-text-embedding'),
  apiKey: z.string().default(''),
  dimensions: z.number().default(1024),
});

export type RagConfig = z.infer<typeof RagConfigSchema>;

export const CronConfigSchema = z.object({
  enabled: z.boolean().default(true),
  dataDir: z.string().default('.'),
});

export const SessionConfigSchema = z.object({
  id: z.string().default('default'),
});

export const UsageConfigSchema = z.object({
  trackingFile: z.string().default('.usage/today.jsonl'),
});

export const CheeseAgentConfigSchema = z.object({
  version: z.string().default('1.0'),
  model: ModelConfigSchema.default({
    provider: 'dashscope',
    name: 'qwen-plus-latest',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: '',
  }),
  plugins: z.array(PluginConfigSchema).default([]),
  channels: ChannelConfigSchema.default({
    feishu: {
      enabled: false,
      appId: '',
      appSecret: '',
      port: 3000,
    },
  }),
  agents: AgentConfigSchema.default({
    maxSpawnDepth: 1,
    maxConcurrent: 3,
    defaultTimeout: 60000,
  }),
  security: SecurityConfigSchema.default({
    defaultRole: 'developer',
    auditLog: true,
    bashTimestamp: true,
  }),
  memory: MemoryConfigSchema.default({
    dataDir: '.',
  }),
  rag: RagConfigSchema.default({
    enabled: true,
    docsDir: 'docs',
    provider: 'dashscope',
    model: 'qwen3.7-text-embedding',
    apiKey: '',
    dimensions: 1024,
  }),
  cron: CronConfigSchema.default({
    enabled: true,
    dataDir: '.',
  }),
  session: SessionConfigSchema.default({
    id: 'default',
  }),
  usage: UsageConfigSchema.default({
    trackingFile: '.usage/today.jsonl',
  }),
});

export type CheeseAgentConfig = z.infer<typeof CheeseAgentConfigSchema>;

// 保留向后兼容类型别名
export const SuperAgentConfigSchema = CheeseAgentConfigSchema;
export type SuperAgentConfig = CheeseAgentConfig;
