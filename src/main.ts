import 'dotenv/config';
import { loadConfig } from './config/loader.js';
import type { SuperAgentConfig } from './config/schema.js';
import fs from 'node:fs';
import { type ModelMessage } from 'ai';
import { createInterface } from 'node:readline';
import { getModel } from './agent/model.js';
import { ToolRegistry } from './tools/registry.js';
import { allTools } from './tools/index.js';
import { createToolSearchTool } from './tools/tool-search.js';
import { createMemoryTool } from './tools/memory-tools.js';
import { createRagTools } from './tools/rag-tools.js';
import { MCPClient } from './tools/mcp-client.js';
import { executeAgent as agentLoop } from './runtime/execution.js';
import { SessionStore } from './session/store.js';
import {
  PromptBuilder, coreRules, toolGuide, deferredTools, sessionContext, modelIdentity,
  type PromptContext,
} from './context/prompt-builder.js';
import { estimateMessageTokens } from './context/defense.js';
import { UsageTracker } from './usage/tracker.js';
import { MemoryStore } from './memory/store.js';
import { memoryContext, ragContext } from './context/prompt-pipe.js';
import { chunkDocument } from './rag/chunker.js';
import { createMockEmbedder, createDashScopeEmbedder, embed } from './rag/embedder.js';
import { SqliteVectorStore } from './rag/sqlite-store.js';
import { createDispatcher, type CommandContext } from './commands/index.js';
import { debugCommands } from './commands/debug.js';
import { contextCommands } from './commands/context.js';
import { memoryCommands } from './commands/memory.js';
import { ragCommands } from './commands/rag.js';
import { dreamCommands } from './commands/dream.js';
import { SkillLoader } from './skills/loader.js';
import { createSkillCommands } from './commands/skill.js';
import { PluginManager } from './plugins/manager.js';
import { supabasePlugin } from './plugins/supabase-plugin.js';
import { createPluginCommands } from './commands/plugin.js';
import type { PluginDefinition } from './plugins/types.js';
import { ChannelGateway } from './channels/gateway.js';
import { FeishuChannel } from './channels/feishu.js';
import { createChannelCommands } from './commands/channel.js';
import { HookPipeline } from './security/hooks.js';
import { classifyBashCommand } from './security/bash-classifier.js';
import { createSecurityCommands } from './commands/security.js';
import { CronService } from './cron/service.js';
import { createCronTool } from './tools/cron-tools.js';
import { createCronCommands } from './commands/cron.js';
import { SubAgentRegistry } from './agents/registry.js';
import { createSpawnTool } from './tools/spawn-tools.js';
import { createAgentCommands } from './commands/agent.js';
import type { SpawnContext } from './agents/spawn.js';
import type { ExecutionOptions } from './runtime/events.js';

/**
 * ══════════════════════════════════════════════════════════════════════════════
 * Cheese Agent 核心组装根 (Composition Root) 与全局运行时调度器
 *
 * 【架构设计与职责】：
 * 1. 控制反转与依赖注入容器（IoC Container）：
 *    - 集中初始化核心子系统（LLM Model、ToolRegistry、MemoryStore、RAG 向量库、
 *      Security HookPipeline、Cron 定时引擎、Sub-Agent 调度中心、Channel 网关）。
 *    - 将各领域服务组装并注入到 Agent 运行生命周期。
 * 2. 交互式终端 REPL（Read-Eval-Print Loop）：
 *    - 监听终端标准输入输出，实现斜杠命令优先拦截分发（/role, /cron, /agents 等），
 *      其余交互自动委托给大模型驱动的 ReAct agentLoop。
 * 3. 多渠道服务常驻守护（Multi-Channel Daemon）：
 *    - 同时承载飞书机器人 Webhook HTTP 服务与终端本地会话。
 * 4. 自动化冷启动引导（Bootstrap Pipeline）：
 *    - 自动扫描 docs/ 目录 Markdown 文档进行自动分块、生成向量并灌入 SQLite-vec。
 * ══════════════════════════════════════════════════════════════════════════════
 */

// ── 1. 加载配置与初始化大语言模型 (Model Factory) ────────────────
const config: SuperAgentConfig = process.env.CHEESE_RUNTIME_CONFIG ? JSON.parse(process.env.CHEESE_RUNTIME_CONFIG) : loadConfig();
const model = getModel(config.model);

// ── 2. 工具注册中心 (Tool Registry) ──────────────────────────────
const registry = new ToolRegistry();
const configuredRole = config.security.defaultRole === 'developer' ? 'owner' : config.security.defaultRole;
if (!['owner', 'collaborator', 'guest'].includes(configuredRole)) throw new Error('未知默认角色');
registry.setRole(configuredRole as 'owner' | 'collaborator' | 'guest');
// 注册基础文件、系统、终端操作工具
registry.register(...allTools);
// 注册动态工具检索器（Deferred Tools 按需发现）
registry.register(createToolSearchTool(registry));

// ── 3. 持久化记忆引擎 (Memory Store) ─────────────────────────────
const memoryStore = new MemoryStore(config.memory.dataDir);
memoryStore.init();
// 注册用户偏好、长期事实读写记忆工具
registry.register(createMemoryTool(memoryStore));

// ── 4. 向量检索与 RAG 引擎 (Vector Store & Embedder) ─────────────
const vectorStore = new SqliteVectorStore(config.rag.enabled ? 'knowledge.db' : ':memory:');
// 优先解析专用 DashScope 向量密钥，避免将主 LLM 的密钥混传导致 401 失败
const ragApiKey =
  config.rag?.apiKey ||
  process.env.DASHSCOPE_API_KEY ||
  (config.model.provider === 'dashscope' ? config.model.apiKey : '');
const embedFn = ragApiKey
  ? createDashScopeEmbedder(ragApiKey)
  : createMockEmbedder();
if (config.rag.enabled) registry.register(...createRagTools(vectorStore, embedFn));

/**
 * 尝试通过 MCP 协议动态连接外部服务（例如 GitHub 官方 MCP Server）
 *
 * 【降级容错】：若未配置 GITHUB_PERSONAL_ACCESS_TOKEN 或系统环境缺少执行权限，静默跳过
 */
async function connectMCP() {
  const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  let canSpawn = true;
  try {
    const { execSync } = await import('node:child_process');
    execSync('echo test', { stdio: 'ignore' });
  } catch {
    canSpawn = false;
  }

  if (githubToken && canSpawn) {
    try {
      const client = new MCPClient('npx', ['-y', '@modelcontextprotocol/server-github'], {
        GITHUB_PERSONAL_ACCESS_TOKEN: githubToken,
      });
      const tools = await registry.registerMCPServer('github', client);
      console.log(`  已注册 ${tools.length} 个 MCP 工具`);
      return;
    } catch {
      /* fallback: 若 MCP 连接失败则静默降级跳过 */
    }
  }
}

// ── 5. 技能系统 (Skill Loader) ───────────────────────────────────
const skillLoader = new SkillLoader('.');
const loadedSkills = skillLoader.load();
const activeSkills = new Set<string>();

// ── 6. 扩展插件系统 (Plugin Manager) ─────────────────────────────
const pluginManager = new PluginManager(registry);
const availablePlugins = new Map<string, PluginDefinition>([
  ['supabase', supabasePlugin],
]);

// ── 7. 安全防御机制与 Hook 管道 (Security Hook Pipeline) ──────────
const hookPipeline = new HookPipeline();

// 前置 Hook：审计日志（对敏感写操作进行前置记录）
hookPipeline.registerPre('audit-log', (toolName, input) => {
  if (toolName === 'write_file' || toolName === 'edit_file') {
    const path = (input as any)?.path || 'unknown';
    console.log(`  [audit] 文件写入操作: ${toolName} → ${path}`);
  }
  return { action: 'allow' };
});

// 后置 Hook：Bash 执行结果时间戳追加
hookPipeline.registerPost('bash-timestamp', (toolName, _input, output) => {
  if (toolName === 'bash') {
    const timestamp = new Date().toISOString();
    return {
      action: 'modify',
      modifiedOutput: `[${timestamp}]\n${output}`,
    };
  }
  return { action: 'allow' };
});

registry.setHookPipeline(hookPipeline);

// ── 8. 定时任务引擎 (Cron Service) ───────────────────────────────
const cronService = new CronService(config.cron.dataDir);
registry.register(createCronTool(cronService));

// ── 9. 子 Agent 编排调度器 (Sub-Agent Concurrency Controller) ─────
const agentRegistry = new SubAgentRegistry({
  maxSpawnDepth: config.agents.maxSpawnDepth,
  maxConcurrent: config.agents.maxConcurrent,
  defaultTimeout: config.agents.defaultTimeout,
});

/**
 * 构造子 Agent 执行上下文工厂
 */
function getSpawnCtx(): SpawnContext {
  return {
    model,
    registry,
    agentRegistry,
    buildSystem: () => builder.build(makePromptCtx()),
    currentDepth: 0,
  };
}

registry.register(createSpawnTool(agentRegistry, getSpawnCtx));

// ── 10. 系统提示词管道装配 (Prompt Pipeline Builder) ──────────────
const builder = new PromptBuilder()
  .pipe('coreRules', coreRules())
  .pipe('modelIdentity', modelIdentity())
  .pipe('toolGuide', toolGuide())
  .pipe('deferredTools', deferredTools())
  .pipe('memoryContext', memoryContext(memoryStore))
  .pipe('ragContext', config.rag.enabled ? ragContext(vectorStore) : () => null)
  .pipe('skillContext', () => skillLoader.buildPromptSection(activeSkills))
  .pipe('sessionContext', sessionContext());

// ── 11. 外部通讯网关 (Channel Gateway: Feishu, Webhook, etc.) ────
const gateway = new ChannelGateway({
  model,
  registry,
  buildSystem: () => builder.build(makePromptCtx()),
});

const FEISHU_PORT = Number(process.env.FEISHU_PORT || '3000');
const feishuChannel = new FeishuChannel({
  appId: config.channels.feishu.appId || process.env.FEISHU_APP_ID || '',
  appSecret: config.channels.feishu.appSecret || process.env.FEISHU_APP_SECRET || '',
  port: process.env.FEISHU_PORT ? FEISHU_PORT : config.channels.feishu.port,
});
if (config.channels.feishu.enabled) gateway.register(feishuChannel);

// ── 12. 斜杠命令派发器 (Slash Commands Dispatcher) ───────────────
const dispatch = createDispatcher([
  ...debugCommands,
  ...contextCommands,
  ...memoryCommands,
  ...ragCommands,
  ...dreamCommands,
  ...createSkillCommands(skillLoader, activeSkills),
  ...createPluginCommands(pluginManager, availablePlugins),
  ...createChannelCommands(gateway),
  ...createSecurityCommands(registry, hookPipeline),
  ...createCronCommands(cronService),
  ...createAgentCommands(agentRegistry),
]);

/**
 * 构建系统提示词上下文环境快照
 */
function makePromptCtx(): PromptContext {
  return {
    toolCount: registry.getActiveTools().length,
    deferredToolSummary: registry.getDeferredToolSummary(),
    sessionMessageCount: 0,
    sessionId: config.session.id,
    modelName: config.model?.name || process.env.MODEL_NAME,
    provider: config.model?.provider || process.env.MODEL_PROVIDER,
  };
}

/**
 * Agent 主运行入口函数 (Main Lifecycle Runner)
 */
export async function startAgent() {
  // 1. 尝试连接外部 MCP 服务
  await connectMCP();

  // 2. 加载已启用的扩展插件
  console.log('  加载插件...');
  for (const [name, def] of availablePlugins) {
    try {
      const tools = await pluginManager.load(def);
      console.log(`  ✓ ${name} — ${tools.length} 个工具`);
    } catch {
      console.log(`  ✗ ${name} — 加载失败`);
    }
  }

  // 3. 启动通讯渠道网关 (如飞书 Webhook 监听端口)
  console.log('  启动 Channel...');
  await gateway.startAll();

  // 4. 加载并启动持久化定时任务引擎
  cronService.load();
  cronService.setExecutor({
    runAgentPrompt: async (prompt, timeout) => {
      const cronMessages: ModelMessage[] = [{ role: 'user', content: prompt }];
      const system = builder.build(makePromptCtx());
      await agentLoop(model, registry, cronMessages, system);
      const lastMsg = cronMessages[cronMessages.length - 1];
      if (!lastMsg) return '(无输出)';
      if (typeof lastMsg.content === 'string') return lastMsg.content;
      if (Array.isArray(lastMsg.content)) {
        return lastMsg.content
          .filter((p: any) => p.type === 'text')
          .map((p: any) => p.text)
          .join('') || '(无输出)';
      }
      return String(lastMsg.content);
    },
    notify: (message) => {
      console.log(`\n${message}`);
    },
  });
  if (config.cron.enabled) cronService.start();
  const cronJobs = cronService.list();

  // 5. 初始化本地持久化会话与计费追踪
  const store = new SessionStore('default');
  let messages: ModelMessage[] = [];
  const timestamps = new Map<number, number>();
  const tracker = new UsageTracker('.usage/today.jsonl');

  // 6. 初始化终端交互式输入接口 (Readline REPL)
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  /**
   * 递归终端交互函数
   */
  function ask() {
    rl.question('\nYou: ', async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === 'exit') {
        console.log('Bye!');
        cronService.stop();
        await gateway.stopAll();
        await pluginManager.unloadAll();
        rl.close();
        return;
      }

      // ── 优先尝试拦截并执行斜杠指令 (/help, /cron, /agents, /role) ──
      const ctx: CommandContext = {
        messages, timestamps, registry, builder, tracker,
        sessionStore: store, model, makePromptCtx, ask,
        memoryStore, vectorStore,
      };
      const handled = dispatch(trimmed, ctx);
      if (handled === 'async') return; // 异步指令，由指令自身控制回调
      if (handled) { ask(); return; }  // 同步指令已完成，进入下一轮输入

      // ── 自然语言输入：交由 Agent ReAct Loop 驱动多步推理与执行 ──
      const userMsg: ModelMessage = { role: 'user', content: trimmed };
      messages.push(userMsg);
      timestamps.set(messages.length - 1, Date.now());
      store.append(userMsg);

      // 动态编译包含最新系统上下文与记忆的提示词
      const currentSystem = builder.build(makePromptCtx());
      const beforeLen = messages.length;

      // 启动 Agent 循环
      await agentLoop(model, registry, messages, currentSystem, tracker);

      // 会话持久化与状态更新
      const newMessages = messages.slice(beforeLen);
      const now = Date.now();
      for (let i = beforeLen; i < messages.length; i++) timestamps.set(i, now);
      store.appendAll(newMessages);

      // 上下文 Token 概览监控
      console.log(`  [Token] ~${estimateMessageTokens(messages)} tokens`);
      ask();
    });
  }

  // 7. 打印启动横幅与当前运行状态
  const role = registry.getRole();
  const toolCount = registry.getActiveTools().length;
  const hooks = hookPipeline.list();

  console.log('Cheese Agent v1.0 (type "exit" to quit)');
  console.log('快捷命令：');
  console.log('  /agents           — 查看子 Agent 记录');
  console.log('  /cron             — 查看定时任务');
  console.log('  /role [角色]      — 查看/切换角色');
  console.log('');
  console.log(`  当前角色: ${role}，可用工具: ${toolCount} 个`);
  console.log(`  Sub-Agent: 最大深度 ${agentRegistry.getConfig().maxSpawnDepth}，最大并发 ${agentRegistry.getConfig().maxConcurrent}`);
  console.log('');
  console.log('  试试：');
  console.log('    帮我对比 Hono、Fastify 和 Express 的性能和生态');
  console.log('    /agents       — 查看子 Agent 执行记录');
  console.log('');

  // 8. 自动扫描与载入本地知识库文档 (docs/ 目录冷启动)
  if (config.rag.enabled && fs.existsSync(config.rag.docsDir)) {
    const files = fs.readdirSync(config.rag.docsDir).filter(f => f.endsWith('.md'));
    if (files.length > 0) {
      console.log(`  发现 ${files.length} 个文档，自动导入知识库...`);
      for (const f of files) {
        const path = `${config.rag.docsDir}/${f}`;
        const text = fs.readFileSync(path, 'utf-8');
        const chunks = chunkDocument(path, text);
        const embeddings = await embed(embedFn, chunks.map(c => c.text));
        vectorStore.addBatch(chunks.map((c, i) => ({ chunk: c, embedding: embeddings[i] })));
      }
      console.log(`  知识库就绪，共 ${vectorStore.size()} 个片段\n`);
    }
  }

  // 进入交互循环
  ask();
}

export async function runTask(messages: ModelMessage[], options: ExecutionOptions = {}) {
  await connectMCP();
  skillLoader.load();
  if (options.activeSkills) {
    activeSkills.clear();
    for (const s of options.activeSkills) activeSkills.add(s);
  }

  // 支持输入形如 /<skill-name> [args] 的一次性快捷触发
  const lastUserMsg = messages[messages.length - 1];
  if (lastUserMsg && lastUserMsg.role === 'user' && typeof lastUserMsg.content === 'string' && lastUserMsg.content.startsWith('/')) {
    const trimmed = lastUserMsg.content.trim();
    const parts = trimmed.slice(1).split(/\s+/);
    const skillName = parts[0];
    const skill = skillLoader.get(skillName);
    if (skill) {
      activeSkills.add(skillName);
      const args = parts.slice(1).join(' ');
      lastUserMsg.content = args ? `${skill.content}\n\n用户指令: ${args}` : skill.content;
    }
  }

  registry.register(createSpawnTool(agentRegistry, () => ({ ...getSpawnCtx(), ...options })));
  if (options.manageCron) registry.register({ ...createCronTool(cronService), execute: options.manageCron });
  try {
    for (const plugin of config.plugins.filter(item => item.enabled)) {
      const definition = availablePlugins.get(plugin.name);
      if (!definition) throw new Error(`未知插件: ${plugin.name}`);
      if (Object.values(plugin.config).some(value => !['string', 'number', 'boolean'].includes(typeof value))) throw new Error(`插件 ${plugin.name} 的配置值必须为字符串、数字或布尔值`);
      await pluginManager.load(definition, plugin.config as Record<string, string | number | boolean>);
    }
    await agentLoop(model, registry, messages, builder.build(makePromptCtx()), undefined, options);
  } finally { await registry.closeAllMCP(); await pluginManager.unloadAll(); }
}
