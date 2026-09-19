# 🧀 Cheese Agent

[中文 (Chinese)](#-cheese-agent-中文) | [English](#-cheese-agent-english)

本机 Web 工作台：`npm run web` → `http://127.0.0.1:3210`。支持多目录、多会话并发和任务树停止，详见[安装与使用](docs/local-web-workbench.md)及[验收记录](docs/verification/local-agent-ui.md)。

---

# 🧀 Cheese Agent (中文)

> **轻量、生产级、自适应的下一代自主智能体系统（Next-Generation Autonomous Multi-Agent Framework）**  
> 基于 TypeScript、Vercel AI SDK、SQLite-vec 与 Model Context Protocol (MCP) 构建，融合**多智能体扇出并发**、**企业级 RBAC 纵深防御**、**三层上下文防线**、**本地嵌入式 RAG** 与**多渠道协作网关**。

---

## 🌟 核心特性一览

```
                       ┌─────────────────────────────────────────┐
                       │          Cheese Agent 调度核心          │
                       └────────────────────┬────────────────────┘
                                            │
         ┌──────────────────┬───────────────┴───────────────┬──────────────────┐
         │                  │                               │                  │
┌────────▼────────┐ ┌───────▼─────────┐             ┌───────▼─────────┐ ┌──────▼─────────┐
│ 多模型适配中枢  │ │ 子智能体并发集群│             │ 纵深安全防御    │ │ 向量知识库 RAG  │
│ (Model Factory) │ │  (Sub-Agents)   │             │ (RBAC & Hooks)  │ │ (SQLite-vec)    │
└─────────────────┘ └─────────────────┘             └─────────────────┘ └─────────────────┘
         │                  │                               │                  │
         ├─ Gemini 3.8/3.7  ├─ 上下文隔离 (Context Bound)   ├─ 三级角色隔离    ├─ qwen3.7-embed
         ├─ DashScope Qwen  ├─ 动态限流与配额管控           ├─ Bash 静态拦截器 ├─ 1024维向量引擎
         └─ OpenAI GPT-5.6  └─ Step 30 强制收敛保障         └─ AOP 审计切面    └─ 内存 Cache-aside
```

### 1. 🧠 多供应商模型适配与级联降级（Model Factory）
- **全协议兼容**：支持直连 **Google Gemini 3.8/3.7** 原生端点，或通过第三方中转网关（如 Flashway / OneAPI）以 OpenAI 兼容协议接入。
- **开箱适配通义千问与 OpenAI**：内置阿里云百炼 **DashScope**（`qwen-plus-latest`）与 **OpenAI**（`gpt-5.6-sol` / `gpt-4o`）驱动。
- **级联判定优先级**：显式参数 > 配置文件（`cheese-agent.config.json`）> 环境变量（`.env`）> 优雅回退至本地离线 `MockModel`。

### 2. ⚡ 子智能体扇出并发与上下文解耦（Sub-Agent Fan-Out）
- **上下文隔离（Context Isolation）**：复杂的信息采集、多文档阅读和深度搜索任务交由独立的瞬态子 Agent 处理，仅回填提炼后的摘要至主 Agent，彻底避免主会话上下文膨胀。
- **并行探索（Parallel Fan-Out）**：通过 `spawn_agent` 工具支持 `tasks: string[]` 一次性并发派发多个子任务，耗时从串行 $O(N)$ 降低至 $O(1)$。
- **安全性与熔断保障**：
  - 递归防炸弹限制：默认 `maxSpawnDepth = 1`，并在子 Agent 工具列表中剔除 `spawn_agent`；
  - 并发配额检测：默认 `maxConcurrent = 3`，超出容量平滑截断拒绝；
  - 强制收敛保障：在执行至最大步数（第 30 步）时强制关闭工具调用（`toolChoice: 'none'`），确保大模型输出文字结论。

### 3. 🛡️ 纵深防御与 RBAC 权限安全体系（Defense-in-Depth Security）
- **三级 RBAC 权限模型**：
  - `owner`（所有者）：拥有全部系统与危险工具权限；
  - `collaborator`（协作者）：禁用高危 `bash` 工具，保障只读或安全修改；
  - `guest`（访客）：仅允许检索知识库、只读浏览文件及记忆查询。
- **AST/正则 Bash 命令分类器**：在工具执行前精准识别 `rm -rf`、`sudo`、`mkfs`、`:(){ :|:& };:`（Fork 炸弹）、`curl | sh` 等危险提权指令并即时熔断。
- **AOP 管道切面（Hook Pipeline）**：支持注册 Pre-Hook（文件修改操作审计记录）与 Post-Hook（时间戳注入、输出敏感信息脱敏）。

### 4. 📚 嵌入式向量知识库（High-Performance RAG）
- **轻量本地化存储**：基于 Node.js 原生 `better-sqlite3` 与 `sqlite-vec` 扩展，无需部署外部重型向量数据库。
- **统一高维表征**：默认对接阿里云百炼 `qwen3.7-text-embedding`，生成行业标准 **1024 维**嵌入向量。
- **Cache-Aside 内存缓存**：文本哈希命中内存后跳过网络请求，结合批处理（Batch Embedding）大幅削减 API 开销。
- **结构化切片（AST Chunking）**：Markdown 语义层级分块，精准保留文档上下文。

### 5. 🎛️ 三层上下文防线（Context Defense Pipeline）
- **Layer 1 - 管道化动态组装（Prompt Pipeline）**：核心规则、工具导引、延迟加载工具集、动态记忆与当前 Session 状态分层拼装。
- **Layer 2 - 工具大文本截断与压缩**：自动监测超长工具输出结果，实施智能局部截断与摘要。
- **Layer 3 - 历史消息修剪（Soft-Pruning & Hard-Clearing）**：根据时间滑动窗口与 Token 预算，软淘汰老旧工具调用中间态，硬清除超期闲置对话。

### 6. ⏰ 零轮询非阻塞定时调度（Non-Blocking Cron Engine）
- **事件驱动时间差调度**：基于 `Croner` 计算毫秒级触发差值，使用精准递归 `setTimeout`，**0 CPU 轮询占用**。
- **多语法解析**：支持标准 5 段式 Cron（如 `0 9 * * 1-5`）、自然语言相对间隔（`every 30s`、`every 5m`）以及 ISO 单次定时执行。
- **容错熔断器**：执行状态自动落盘（`.cron/jobs.json`），连续失败 3 次自动进入熔断失活状态。

### 7. 🔌 多通道协作网关与协议集成（Gateway & Plugins）
- **企业协作接入**：基于 Hono 框架与飞书 SDK，支持机器人事件监听、消息异步回调与长会话隔离。
- **MCP 协议支持**：支持以客户端形式动态接入 GitHub 官方等符合 Model Context Protocol 规范的外部工具服务。
- **插件系统与技能（Skills）**：支持动态热插拔 Supabase 扩展插件与基于 Markdown 定义的技能增强库。

---

## 📂 项目架构与目录索引

```text
cheese-agent/
├── docs/                        # 知识库源文档（自动切片并导入向量库）
│   ├── api-design.md
│   └── deployment-guide.md
├── src/
│   ├── index.ts                 # CLI 入口与向导路由
│   ├── main.ts                  # 全局依赖注入与 Agent 生命周期主循环
│   ├── mock-model.ts            # 本地测试与离线 Mock 模型实现
│   │
│   ├── agent/                   # 核心 Agent 推理引擎
│   │   ├── loop.ts              # Agent 交互主循环（AI SDK streamText）
│   │   ├── model.ts             # 统一模型工厂（Google/Gemini, DashScope, OpenAI）
│   │   ├── loop-detection.ts    # 死循环工具调用检测器
│   │   └── retry.ts             # 网络异常指数退避重试
│   │
│   ├── agents/                  # 派生子智能体系统 (Sub-Agents)
│   │   ├── registry.ts          # 子 Agent 状态机与并发配额管理
│   │   ├── spawn.ts             # 单任务派发与 Fan-out 批量并行执行
│   │   └── types.ts             # 深度控制与状态定义
│   │
│   ├── context/                 # 上下文构建与防御机制
│   │   ├── defense.ts           # 三层上下文渐进防线算法
│   │   ├── prompt-builder.ts    # 链式 Prompt 构建器
│   │   ├── prompt-pipe.ts       # 记忆与 RAG 上下文注入管道
│   │   ├── compressor.ts        # 历史记录结构性压缩
│   │   └── view.ts              # 上下文 Token 可视化透视
│   │
│   ├── security/                # 安全与权限防护
│   │   ├── roles.ts             # RBAC 角色策略 (owner / collaborator / guest)
│   │   ├── bash-classifier.ts   # 危险 Bash 指令语法分析拦截器
│   │   └── hooks.ts             # AOP 前置/后置审计切面管道
│   │
│   ├── rag/                     # 检索增强生成 (RAG)
│   │   ├── sqlite-store.ts      # sqlite-vec 向量数据库存储驱动
│   │   ├── embedder.ts          # DashScope 1024 维 Embedding 与内存缓存
│   │   ├── chunker.ts           # 文档分块器
│   │   ├── search.ts            # 混合检索算法
│   │   └── store.ts             # 抽象向量存储接口
│   │
│   ├── cron/                    # 定时调度引擎
│   │   ├── service.ts           # 非阻塞定时器与任务生命周期
│   │   ├── parser.ts            # 相对时间与 Cron 表达式解析器
│   │   ├── store.ts             # 定时任务磁盘持久化
│   │   └── types.ts             # 任务状态与调度合约
│   │
│   ├── channels/                # 通讯渠道网关
│   │   ├── gateway.ts           # 多渠道统一调度网关
│   │   ├── feishu.ts            # 飞书 (Lark) 企业机器人接入通道
│   │   └── types.ts             # 通道消息协议
│   │
│   ├── tools/                   # 工具体系
│   │   ├── registry.ts          # 工具注册中心（支持并发读写锁与 MCP）
│   │   ├── spawn-tools.ts       # spawn_agent 工具暴露
│   │   ├── rag-tools.ts         # rag_search / rag_import 工具
│   │   ├── cron-tools.ts        # cron_create / cron_list / cron_delete
│   │   ├── memory-tools.ts      # 记忆读写检索工具
│   │   ├── search-tools.ts      # Tavily / Serper 联网检索工具
│   │   ├── tool-search.ts       # 延迟工具元搜索
│   │   └── mcp-client.ts        # MCP 协议客户端包装器
│   │
│   ├── memory/                  # 结构化短期与长期记忆
│   │   ├── store.ts             # 文件级记忆存储库
│   │   ├── search.ts            # 记忆相关度排序与过滤
│   │   └── validator.ts         # 记忆一致性校验
│   │
│   ├── commands/                # 命令行交互式 / 指令集
│   │   ├── agent.ts             # /agents 子 Agent 观测
│   │   ├── security.ts          # /role /hooks 安全审计
│   │   ├── cron.ts              # /cron 定时任务查看与管控
│   │   ├── rag.ts               # /rag 检索测试与向量库分析
│   │   ├── memory.ts            # /mem 记忆查看
│   │   ├── context.ts           # /ctx 上下文 Token 视窗
│   │   ├── channel.ts           # /channels 渠道状态
│   │   └── plugin.ts            # /plugins 插件管理
│   │
│   ├── config/                  # 系统全局配置
│   │   ├── schema.ts            # 基于 Zod 的严谨配置类型定义
│   │   ├── loader.ts            # 环境变量占位符替换与校验加载器
│   │   └── init.ts              # 交互式快速初始化向导
│   │
│   └── usage/                   # 计量计费与 Token 统计
│       └── tracker.ts           # 消费账本与价格矩阵追踪器
│
├── cheese-agent.config.json     # 核心运行配置文件
├── tsconfig.json                # TypeScript 编译选项
└── package.json
```

---

## 🚀 快速开始

### 1. 环境准备
- Node.js >= 20.0.0
- pnpm >= 8.0.0

### 2. 安装依赖
```bash
pnpm install
```

### 3. 配置向导（一键生成配置与环境）
执行内置交互式配置向导：
```bash
pnpm run init
```
向导将引导选择主模型（Gemini 3.8/3.7、DashScope、OpenAI）、填入 API Key、设置知识库以及配置飞书机器人，自动生成 `cheese-agent.config.json` 与 `.env`。

### 4. 手动配置示例（`cheese-agent.config.json`）
```json
{
  "version": "1.0",
  "model": {
    "provider": "google",
    "name": "gemini-3.8-flash",
    "baseURL": "https://api.flashway.ai/v1",
    "apiKey": "${GOOGLE_GENERATIVE_AI_API_KEY}"
  },
  "rag": {
    "enabled": true,
    "docsDir": "docs",
    "provider": "dashscope",
    "model": "qwen3.7-text-embedding",
    "apiKey": "${DASHSCOPE_API_KEY}",
    "dimensions": 1024
  },
  "agents": {
    "maxSpawnDepth": 1,
    "maxConcurrent": 3,
    "defaultTimeout": 60000
  },
  "security": {
    "defaultRole": "developer",
    "auditLog": true,
    "bashTimestamp": true
  }
}
```

### 5. 启动运行
```bash
# 开发监听模式
pnpm run dev

# 生产执行模式
pnpm start
```

---

## 💬 控制台常用交互指令

在终端会话中输入 `/` 即可触发各类系统观测与管理命令：

| 指令 | 作用与说明 |
| :--- | :--- |
| `/agents` | 查看所有子 Agent 运行记录、当前并发数及状态（运行中/完成/超时） |
| `/role [owner\|collaborator\|guest]` | 查看或即时切换当前安全权限角色 |
| `/hooks` | 查看安全防御管道已挂载的 Pre-Hook 与 Post-Hook 审计钩子 |
| `/cron` | 查看当前已注册的定时任务列表、下次执行时间与状态 |
| `/rag [query]` | 直接测试检索当前 SQLite 知识库中的向量相似度结果 |
| `/ctx` | 显示当前上下文 Token 占用、三层防线截断状态与消息明细 |
| `/mem` | 查看当前工作区已持久化的记忆库实体 |
| `/channels` | 查看飞书等外部通讯网关的监听端口与连通性 |
| `/plugins` | 查看已加载的外部插件状态（如 Supabase） |
| `exit` | 优雅退出系统并平合关闭定时任务与渠道监听 |

---

## 🛠️ 典型应用场景示例

### 场景 A：子 Agent 并发深度调研
```text
You: 请帮我深度对比 Hono、Fastify 和 Express 在高并发下的内存管理机制，并分别给出压测数据。
```
> **系统行为**：主 Agent 将自动调用 `spawn_agent` 工具，并发派发 3 个子 Agent 分别抓取三种框架的官方文档与评测报告，独立在子上下文中消化长文本，最后只将凝练的对比表格回填给用户，主上下文仅增加不到 500 Token。

### 场景 B：非阻塞定时监控
```text
You: 帮我创建一个每 10 分钟检查一次生产服务器健康状态的定时任务。
```
> **系统行为**：Agent 自动调用 `cron_create` 工具注册任务，定时调度器采用纯事件驱动的递归 `setTimeout` 进行计时，到期后在后台拉起子会话执行探针并在终端输出警报。

---
---

# 🧀 Cheese Agent (English)

> **A Lightweight, Production-Grade, Self-Adaptive Next-Generation Autonomous Multi-Agent Framework**  
> Built with TypeScript, Vercel AI SDK, SQLite-vec, and Model Context Protocol (MCP). Engineered with **Sub-Agent Fan-Out Concurrency**, **Enterprise-Grade RBAC Defense-in-Depth**, **Three-Layer Context Defense Pipeline**, **Embedded Local RAG**, and **Multi-Channel Collaboration Gateways**.

---

## 🌟 Overview of Core Features

```
                       ┌─────────────────────────────────────────┐
                       │       Cheese Agent Core Orchestrator    │
                       └────────────────────┬────────────────────┘
                                            │
         ┌──────────────────┬───────────────┴───────────────┬──────────────────┐
         │                  │                               │                  │
┌────────▼────────┐ ┌───────▼─────────┐             ┌───────▼─────────┐ ┌──────▼─────────┐
│  Model Factory  │ │    Sub-Agents   │             │   RBAC & Hooks  │ │ Local RAG Engine│
│ Multi-Provider  │ │ Parallel Fan-Out│             │ Defense-in-Depth│ │  (SQLite-vec)   │
└─────────────────┘ └─────────────────┘             └─────────────────┘ └─────────────────┘
         │                  │                               │                  │
         ├─ Gemini 3.8/3.7  ├─ Context Isolation            ├─ 3-Tier RBAC     ├─ qwen3.7-embed
         ├─ DashScope Qwen  ├─ Dynamic Quota Management     ├─ AST Bash Guard  ├─ 1024-dim Engine
         └─ OpenAI GPT-5.6  └─ Step 30 Convergence Force    └─ AOP Pipeline    └─ Cache-Aside RAM
```

### 1. 🧠 Multi-Provider Model Factory & Cascading Fallback
- **Full Protocol Adaptability**: Direct connection to **Google Gemini 3.8/3.7** native endpoints or seamless OpenAI-compatible gateway forwarding (e.g., Flashway / OneAPI).
- **Out-of-the-Box Qwen & OpenAI Support**: Built-in drivers for Alibaba Cloud **DashScope** (`qwen-plus-latest`) and **OpenAI** (`gpt-5.6-sol` / `gpt-4o`).
- **Cascading Resolution Priority**: Explicit Invocation Arguments > Configuration File (`cheese-agent.config.json`) > Environment Variables (`.env`) > Graceful Fallback to offline `MockModel`.

### 2. ⚡ Sub-Agent Fan-Out Concurrency & Context Isolation
- **Context Isolation**: Long-running information gathering, document reading, and deep web searches are delegated to isolated ephemeral child agents. Only concise synthesized summaries are returned to the parent agent, effectively eliminating context explosion.
- **Parallel Fan-Out**: The `spawn_agent` tool supports batch task arrays (`tasks: string[]`), dispatching parallel child agents simultaneously and reducing overall wall-clock latency from serial $O(N)$ to $O(1)$.
- **Recursive Safety & Circuit Breakers**:
  - Fork-bomb prevention: Default `maxSpawnDepth = 1`, and `spawn_agent` is automatically stripped from the sub-agent toolset.
  - Concurrency quota enforcement: Default `maxConcurrent = 3`, with graceful rejection and capacity slicing.
  - Guaranteed convergence: Tool calling is forcibly disabled (`toolChoice: 'none'`) at Step 30 to compel the model to formulate a final text summary.

### 3. 🛡️ Defense-in-Depth Security & RBAC
- **Three-Tier RBAC Permissions**:
  - `owner`: Full system access, including arbitrary shell execution.
  - `collaborator`: High-risk `bash` execution disabled; safe read/write operations permitted.
  - `guest`: Read-only access restricted to RAG knowledge base retrieval, file reading, and memory search.
- **AST / Regex Static Bash Command Classifier**: Intercepts destructive commands such as `rm -rf`, `sudo`, `mkfs`, fork bombs (`:(){ :|:& };:`), and piped execution (`curl | sh`) before execution.
- **AOP Hook Pipeline**: Extensible Pre-Hooks (file write auditing) and Post-Hooks (timestamp injection, secret masking).

### 4. 📚 Embedded High-Performance RAG (SQLite-vec)
- **Zero Heavy Infrastructure**: Runs entirely in-process using Node.js native `better-sqlite3` and the `sqlite-vec` vector extension.
- **1024-Dimensional Semantic Representation**: Integrated with Alibaba Cloud DashScope `qwen3.7-text-embedding` configured at 1024 dimensions.
- **Cache-Aside In-Memory Caching**: Text hashes cached in RAM skip external HTTP requests, drastically reducing latency and API costs.
- **AST Semantic Markdown Chunking**: Hierarchical chunking preserves code blocks and semantic structure.

### 5. 🎛️ Three-Layer Context Defense Pipeline
- **Layer 1 - Pipeline Assembly (Prompt Pipeline)**: Composes core instructions, dynamic tool guide, deferred tool catalog, active memories, and session state.
- **Layer 2 - Output Truncation & Compression**: Detects oversized tool outputs and applies smart window truncation.
- **Layer 3 - Sliding Window Pruning**: Evaluates token consumption and age; applies soft-pruning to legacy tool calls and hard-clearing to stale conversational rounds.

### 6. ⏰ Non-Blocking Event-Driven Cron Engine
- **Zero Polling Overhead**: Powered by `Croner` calculating millisecond delta intervals via recursive `setTimeout` with **0% idle CPU usage**.
- **Versatile Scheduling Expressions**: Supports standard 5-part Cron (e.g., `0 9 * * 1-5`), natural language intervals (`every 30s`, `every 5m`), and one-off ISO timestamps.
- **Persistent Circuit Breaker**: Job state persisted to `.cron/jobs.json`; automatically suspends jobs after 3 consecutive failures.

### 7. 🔌 Multi-Channel Collaboration & Protocol Extensibility
- **Enterprise Messaging**: Hono-based webhook gateway supporting Feishu (Lark) enterprise bots with event dispatch and async streaming replies.
- **MCP Client Integration**: Built-in client support for external servers conforming to Anthropic's Model Context Protocol (e.g., GitHub MCP Server).
- **Extensible Plugins & Skills**: Hot-pluggable plugin architecture (e.g., Supabase) and filesystem-based Markdown skill packs.

---

## 📂 Project Structure & Architecture

```text
cheese-agent/
├── docs/                        # Knowledge base source documents
│   ├── api-design.md
│   └── deployment-guide.md
├── src/
│   ├── index.ts                 # CLI entry point and setup wizard router
│   ├── main.ts                  # Dependency injection root & REPL loop
│   ├── mock-model.ts            # Local testing mock model implementation
│   │
│   ├── agent/                   # Core reasoning engine
│   │   ├── loop.ts              # Agentic execution loop (AI SDK streamText)
│   │   ├── model.ts             # Unified model factory (Google, DashScope, OpenAI)
│   │   ├── loop-detection.ts    # Infinite loop detector
│   │   └── retry.ts             # Exponential backoff retry handler
│   │
│   ├── agents/                  # Ephemeral Sub-Agent orchestration
│   │   ├── registry.ts          # State machine and concurrency quota manager
│   │   ├── spawn.ts             # Task dispatch and parallel fan-out runner
│   │   └── types.ts             # Sub-agent state contracts and limits
│   │
│   ├── context/                 # Context defense and prompt compilation
│   │   ├── defense.ts           # 3-layer progressive context defense
│   │   ├── prompt-builder.ts    # Fluent prompt composition pipeline
│   │   ├── prompt-pipe.ts       # Context injection middleware
│   │   ├── compressor.ts        # Structural history compressor
│   │   └── view.ts              # Token usage visualizer
│   │
│   ├── security/                # Security and access control
│   │   ├── roles.ts             # Role-Based Access Control (RBAC)
│   │   ├── bash-classifier.ts   # Static shell command safety classifier
│   │   └── hooks.ts             # AOP Pre/Post execution hooks
│   │
│   ├── rag/                     # Retrieval-Augmented Generation
│   │   ├── sqlite-store.ts      # sqlite-vec vector storage driver
│   │   ├── embedder.ts          # 1024-dim embedding client with cache
│   │   ├── chunker.ts           # Semantic Markdown AST chunker
│   │   ├── search.ts            # Hybrid vector search algorithm
│   │   └── store.ts             # Abstract vector store interface
│   │
│   ├── cron/                    # Non-blocking scheduler
│   │   ├── service.ts           # Timer runtime and lifecycle coordinator
│   │   ├── parser.ts            # Schedule expression parser
│   │   ├── store.ts             # Job state persistence
│   │   └── types.ts             # Cron contracts and state types
│   │
│   ├── channels/                # External communication gateways
│   │   ├── gateway.ts           # Multi-channel routing gateway
│   │   ├── feishu.ts            # Feishu / Lark enterprise bot integration
│   │   └── types.ts             # Channel contracts and events
│   │
│   ├── tools/                   # Tool registry and implementations
│   │   ├── registry.ts          # Central tool registry with read/write locks
│   │   ├── spawn-tools.ts       # spawn_agent tool provider
│   │   ├── rag-tools.ts         # rag_search / rag_import tools
│   │   ├── cron-tools.ts        # cron_create / cron_list / cron_delete
│   │   ├── memory-tools.ts      # Workspace memory management tools
│   │   ├── search-tools.ts      # Tavily / Serper web search tools
│   │   ├── tool-search.ts       # Meta-search for deferred tools
│   │   └── mcp-client.ts        # Model Context Protocol client wrapper
│   │
│   ├── memory/                  # Long-term workspace memory
│   │   ├── store.ts             # File-backed memory store
│   │   ├── search.ts            # Semantic memory relevance ranking
│   │   └── validator.ts         # Consistency check
│   │
│   ├── commands/                # Interactive CLI slash-commands
│   │   ├── agent.ts             # /agents inspection
│   │   ├── security.ts          # /role /hooks security management
│   │   ├── cron.ts              # /cron job management
│   │   ├── rag.ts               # /rag vector search evaluation
│   │   ├── memory.ts            # /mem memory inspection
│   │   ├── context.ts           # /ctx token and defense viewer
│   │   ├── channel.ts           # /channels status inspector
│   │   └── plugin.ts            # /plugins management
│   │
│   ├── config/                  # Global configuration management
│   │   ├── schema.ts            # Zod configuration schemas
│   │   ├── loader.ts            # Environment variable substitution & loader
│   │   └── init.ts              # Interactive setup wizard
│   │
│   └── usage/                   # Token telemetry & cost tracking
│       └── tracker.ts           # Usage ledger & pricing matrix
│
├── cheese-agent.config.json     # Primary runtime configuration
├── tsconfig.json                # TypeScript compiler configuration
└── package.json
```

---

## 🚀 Quick Start

### 1. Prerequisites
- Node.js >= 20.0.0
- pnpm >= 8.0.0

### 2. Install Dependencies
```bash
pnpm install
```

### 3. Interactive Configuration Wizard
Run the interactive configuration CLI:
```bash
pnpm run init
```
The wizard guides you through selecting the primary model (Gemini 3.8/3.7, DashScope, OpenAI), configuring API keys, setting up RAG knowledge embeddings, and configuring enterprise channels. It automatically writes `cheese-agent.config.json` and `.env`.

### 4. Configuration Reference (`cheese-agent.config.json`)
```json
{
  "version": "1.0",
  "model": {
    "provider": "google",
    "name": "gemini-3.8-flash",
    "baseURL": "https://api.flashway.ai/v1",
    "apiKey": "${GOOGLE_GENERATIVE_AI_API_KEY}"
  },
  "rag": {
    "enabled": true,
    "docsDir": "docs",
    "provider": "dashscope",
    "model": "qwen3.7-text-embedding",
    "apiKey": "${DASHSCOPE_API_KEY}",
    "dimensions": 1024
  },
  "agents": {
    "maxSpawnDepth": 1,
    "maxConcurrent": 3,
    "defaultTimeout": 60000
  },
  "security": {
    "defaultRole": "developer",
    "auditLog": true,
    "bashTimestamp": true
  }
}
```

### 5. Running the Agent
```bash
# Watch mode for development
pnpm run dev

# Standard production start
pnpm start
```

---

## 💬 Interactive CLI Commands

Prefix commands with `/` in the interactive console:

| Command | Description |
| :--- | :--- |
| `/agents` | Inspect all sub-agent execution runs, active concurrency, and statuses |
| `/role [owner\|collaborator\|guest]` | View or switch the active RBAC security role |
| `/hooks` | Inspect registered Pre-Hook and Post-Hook security audit filters |
| `/cron` | List registered cron jobs, next execution times, and circuit status |
| `/rag [query]` | Query the local SQLite-vec vector knowledge base directly |
| `/ctx` | View active context token consumption, truncation states, and message details |
| `/mem` | Inspect persistent workspace memory entities |
| `/channels` | View external gateway connectivity (e.g., Feishu bot webhook) |
| `/plugins` | Inspect loaded external plugins (e.g., Supabase) |
| `exit` | Gracefully terminate all active background jobs, channels, and loops |

---

## 📄 License

This project is open-sourced under the [MIT License](LICENSE). Contributions, issues, and feature requests are welcome!
