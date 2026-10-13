# 工程知识中心 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. 用户要求优先：主代理负责代码、取舍和最终验证；子代理仅做只读探索，不采用子代理编码或双阶段审查。

**Goal:** 建设独立、可共享、可追溯的工程知识中心，使通用和领域 Agent 联合源码、文档和经验回答工程问题，并支持局部图谱及有界跨文档查询。

**Architecture:** 主进程 KnowledgeService 集中持有 SQLite、来源同步及索引写入，Web 和 worker 通过服务接口及受限 IPC 接入。原文版本、来源作用域和证据状态贯穿文本、符号、图谱及沉淀；现有混合检索复用。先交付资料与引用，再增加结构图谱和自动沉淀，最后串起关系查询。

**Tech Stack:** TypeScript 6.0.3、Hono、better-sqlite3、sqlite-vec、FTS5、原生 HTML/CSS/JS；新增 Chokidar 4.x，TypeScript Compiler API 用于语法解析。外部采集首版用服务端 HTTP 适配器，不同时安装多套 SDK。

**Spec:** [工程知识中心设计](../specs/2026-10-13-engineering-knowledge-design.md)。执行者先读本计划与该设计，历史个人 Web/React 计划不作为本次迁移目标。

**Status:** 2026-10-13，仅生成计划，未实施。任务依赖顺序为 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9；相关测试在阶段末集中运行，不为每个任务设测试或审查门槛。

## Global Constraints

- 验证只覆盖本次改动的关键行为和实际风险，通过后停止。
- 不为每个小改动、展示细节或内部辅助函数新增测试。
- 每阶段集中运行一次相关测试和一次构建；失败后仅重跑受影响项。
- 不默认运行全量测试、多轮审查、性能压测、付费模型评测或浏览器截图矩阵。
- 后续开发继续遵守最小必要验证；发现具体问题才扩大检查范围。
- 子代理只做只读探索、定位和核验；代码修改、方案取舍和最终验证由主代理负责。
- 源码模块以 300–500 行为目标，新功能独立成模块；既有大文件只接入小入口，不追加功能主体。
- 沿用原生 Web 和 Runtime，不做 React 迁移、完整调用图、多语言结构解析、PDF/Word/OCR 或外部图数据库。
- 项目文件在本机同步；公开采集只处理明确启用的来源，凭据不进入引用、事件或普通 API 响应。
- 旧 knowledge.db 原位保留，不自动删除、清空或推断其历史行号。

---

## 1. 交付阶段和停止条件

| 阶段 | 任务 | 可用交付物 | 集中检查 |
| --- | --- | --- | --- |
| P1 资料与引用 | 1–4 | 接入项目、管理资料、增量同步、选库检索、查看引用 | 4 个新关键场景 + 必要的既有接入回归 + 1 次 build |
| P2 工程图谱与沉淀 | 5–7 | TS/JS 结构、局部图谱、运行证据、候选及纠错 | 2 个新关键场景 + 1 次 build |
| P3 关联查询与公开来源 | 8–9 | 2 跳跨文档查询、公开资料适配器、完整闭环 | 2 个新关键场景 + 1 次 build + 1 次人工烟雾 |

默认新增 8 个合并场景，分布在 3 个测试文件；同一夹具覆盖多个相关断言，不为每个 API、UI 状态或 helper 单独铺测试。数字是控制投入的目标，真实缺陷需要补回归时可增加；不能为凑数删掉已发现缺陷的检查。

无代码变化时不重跑上一阶段检查。提交前做一次 diff 自查即可，不默认派 review/security/UI 等审查代理。可按阶段提交代码，但不机械要求每个小步骤单独 commit。

## 2. 文件与职责

| 文件 | 职责 |
| --- | --- |
| src/knowledge/types.ts | DTO、证据、上下文、RPC 联合类型 |
| src/knowledge/schema.ts | 知识领域表和 schemaVersion |
| src/knowledge/store.ts | 文档身份、版本发布、索引事务和关闭 |
| src/knowledge/libraries.ts | 库与 Agent 绑定、范围解析 |
| src/knowledge/sources.ts | 来源清单、启用状态和作业记录 |
| src/knowledge/chunks.ts | 保留原文位置的文本分块 |
| src/knowledge/local-sync.ts | hash、文件监听、单一同步队列 |
| src/knowledge/retriever.ts | 已生效/候选分区、混合召回和引用 |
| src/knowledge/service.ts、index.ts | 组合门面及公开导出 |
| src/knowledge/code-indexer.ts、graph.ts | TS/JS 结构和有界图查询 |
| src/knowledge/capture.ts、evidence.ts | 任务提取、证据状态和纠错 |
| src/knowledge/providers.ts | Context7/Firecrawl HTTP 适配器 |
| src/tools/knowledge-tools.ts | rag_search、rag_ingest、knowledge_graph 工具适配 |
| src/tools/bash.ts | 保留文本输出的 bash 工具及可选结构化证据回调 |
| src/rag/legacy-runtime.ts | 按需初始化旧 CLI RAG，避免 worker 导入时开库 |
| src/runtime/knowledge-rpc.ts | 主进程绑定上下文的 RPC 分发 |
| src/web/knowledge-routes.ts | 知识 API、证据读取及静态资源登记 |
| web/knowledge/{controller,views,citations,graph}.js | 知识页、证据面板和图谱交互 |
| web/knowledge/style.css | 知识中心独立样式 |
| tests/knowledge-core.test.ts | P1 4 个数据/范围/同步场景 |
| tests/knowledge-engineering.test.ts | P2 2 个结构/沉淀场景 |
| tests/knowledge-query.test.ts | P3 2 个关联/公开来源场景 |
| tests/helpers/knowledge-fixture.ts | 小型临时项目、mock embedding、清理 |
| docs/engineering-knowledge.md | 用户用法、边界和排错入口 |

现有 src/main.ts、runtime/service.ts、worker.ts、worker-client.ts、events.ts、web/server.ts 接入服务。web/app.js 只加 import、知识路由分支、挂载调用；web/index.html 只加入口/容器/style 链接。禁止把整个知识页写进 app.js 或 style.css。

## 3. 公共契约

在任务 1 定义以下契约，后续任务沿用同名字段；实现中如需调整，直接同步修改相邻调用，不保留两套名字。

```ts
export type Scope = 'public' | 'project';
export type KnowledgeStatus =
  'candidate' | 'effective' | 'needs_review' | 'invalidated';
export type SourceKind =
  'local' | 'managed' | 'capture' | 'context7' | 'firecrawl';
export type QueryMode = 'fact' | 'experience';
export interface KnowledgeContext {
  workspaceId: string;
  workspacePath: string;
  agentId: string;
  runId?: string;
  role: 'owner' | 'collaborator' | 'guest';
}
export interface SourceSpan {
  startOffset: number;
  endOffset: number;
  startLine: number; // 1-based
  endLine: number;
}
export interface Citation {
  id: string; documentId: string; revisionId: string;
  sourceUri: string; span: SourceSpan;
  hash: string; commit?: string;
  status: KnowledgeStatus;
  evidenceKind: 'code' | 'document' | 'decision' | 'observation' | 'inference';
}
export interface KnowledgeHit {
  text: string; score: number; citation: Citation;
}
export interface SearchRequest {
  query: string; mode: QueryMode; topK: number;
  libraryIds?: string[]; // 只允许缩小/选择可访问范围
  includeGraph?: boolean;
}
export interface SearchResponse {
  generation: number; libraryIds: string[];
  hits: KnowledgeHit[]; warnings: string[];
}
export type KnowledgeRequest =
  | { op: 'search'; input: SearchRequest }
  | { op: 'citation'; input: { citationId: string } }
  | { op: 'graph'; input: { entityId: string; hops: 1 | 2 } }
  | { op: 'ingest'; input: { path: string; libraryId: string } };
export type KnowledgeRpc = (request: KnowledgeRequest) => Promise<unknown>;
```

Library 具有 id/name/description/scope/workspaceId?/role 字段，role 为 basic/domain/project/legacy。Source 具有 id/libraryId/kind/locator/enabled/versionConstraint?。RevisionDraft 具有 sourceId/sourceKey/content/hash/commit?/expectedPreviousRevisionId/chunks，expectedPreviousRevisionId 类型为 string | null，新文档用 null；chunks 是 text + SourceSpan + embedding?，无 embedding 时只建 FTS。

KnowledgeService 构造参数为 { dataDir, embedderForWorkspace?, modelForWorkspace? }，后两者为按 workspaceId 解析的函数，默认缺省分别走 FTS-only 和规则提取。所有访问方法接收真实 KnowledgeContext；API/worker 不自行构造该上下文。

## Task 1: 文档版本、作用域和原子索引

**Files:** Create types.ts、schema.ts、store.ts、libraries.ts、chunks.ts、index.ts；Modify src/rag/sqlite-store.ts；Create tests/helpers/knowledge-fixture.ts 与 knowledge-core.test.ts 的前 2 个场景。

**Consumes:** 现有 EmbeddingFn、SearchResult、SqliteVectorStore 的混合评分。

**Produces:**

```ts
class KnowledgeStore {
  constructor(dbPath: string);
  createLibrary(input: Library): Library;
  createSource(input: Source): Source;
  publishRevision(input: RevisionDraft): { documentId: string; revisionId: string };
  deleteDocument(documentId: string): void;
  readRevision(revisionId: string): { content: string; hash: string };
  readSnapshot<T>(fn: (generation: number) => T): T; // 仅同步回调
  currentChunks(documentId: string): Array<{ id: string; text: string; span: SourceSpan }>;
  close(): void;
}
function chunkWithSpans(content: string): Array<{ text: string; span: SourceSpan }>;
```

- [x] 创建 libraries/sources/documents/revisions/chunk_refs/bindings/generation 表；Document 以 sourceId+规范化 sourceKey 唯一。revision 原文不可变，activeRevisionId 指向当前发布版。
- [x] 扩展 SqliteVectorStore 构造器为 string | Database.Database；注入连接时不拥有连接，close() 仅关闭自身连接。新增 upsertIndexedChunks(items)、removeChunks(ids)、searchPrepared(query, vector?, topK, collectionIds?)；旧 add/addBatch/hybridSearch 保持签名，hybridSearch 复用 searchPrepared 的同步融合逻辑。
- [x] upsertIndexedChunks 的 embedding 缺省时写元数据/FTS，清除旧 vec 项；embedding=[] 仅作元表占位，不能插入零向量。collection_id 作为内部 libraryId:effective/candidate 分区，不由调用者拼接任意值。
- [x] KnowledgeStore 与 vectorStore 使用同一连接；网络/embedding 在事务外准备，当前片段替换、chunk_refs、activeRevisionId、generation 更新一起提交。新文件 expectedPreviousRevisionId=null，更新使用上一版 ID，冲突时丢弃陈旧作业并重新读取最新文件。

```ts
const publish = db.transaction(() => {
  assertPreviousRevision(documentId, draft.expectedPreviousRevisionId);
  vectorStore.removeChunks(previousChunkIds);
  insertImmutableRevision(draft);
  vectorStore.upsertIndexedChunks(nextChunks);
  replaceChunkRefs(documentId, nextChunks);
  activateRevision(documentId, revisionId);
  incrementGeneration();
});
publish();
```

上述 helper 均是 store.ts/schema.ts 内部函数，分别负责上一版 CAS、revision INSERT、chunk_refs 替换、activeRevisionId UPDATE、generation UPDATE；不得把事务拆到不同 DB 连接。

- [x] 分块按原文偏移切片，再计算行号；每块目标约 1,200 字符、上限 2,000，优先行/段落边界，允许 2 行重叠。不复用会 trim/重组文字的旧 chunker 来伪造 span。
- [x] 加入 2 个合并场景：长文变短文/删除后旧片段退出而历史原文可读；一次索引写入异常导致事务回滚、旧 activeRevision 和 generation 保持不变。测试库使用 BEFORE INSERT ON chunks 触发器，对指定测试文本执行 RAISE(ABORT)，无需给生产代码增加故障注入 API，不做随机故障矩阵。

**关键断言示例：**

```ts
assert.equal(store.currentChunks(first.documentId).length, 1);
assert.equal(store.readRevision(first.revisionId).content, original);
store.deleteDocument(first.documentId);
assert.deepEqual(store.currentChunks(first.documentId), []);
```

**交付:** 稳定文档身份、可引用版本及可事务替换的检索索引。此任务不运行整套测试，检查集中到 P1 末。

## Task 2: 来源发现和本地增量同步

**Files:** Create sources.ts、local-sync.ts、service.ts；Modify package.json、pnpm-lock.yaml；Extend knowledge-core.test.ts 的第 3 个场景。

**Produces:**

```ts
KnowledgeService.attachWorkspace(ctx: KnowledgeContext): void;
KnowledgeService.discoverSources(ctx: KnowledgeContext): Promise<SourceProposal[]>;
KnowledgeService.enableSource(ctx: KnowledgeContext, sourceId: string): Promise<void>;
KnowledgeService.syncSource(ctx: KnowledgeContext, sourceId: string): Promise<void>;
KnowledgeService.close(): Promise<void>;
```

SourceProposal 是 Source + {sourceId:string, reason:string, enabled:false}，sourceId 等于已保存的 Source.id；发现时保存禁用来源，重复发现不覆盖用户启用/禁用选择。首次启用仅对选择的清单执行。

- [x] 安装 chokidar@^4，移动当前 typescript 依赖到 dependencies，保留 ^6.0.3。TS 解析阶段使用运行时依赖；不增加 ts-morph、Neo4j 或 Python 服务。
- [x] 用 fast-glob 发现 README、docs、src、AGENT/AGENTS、package.json/锁文件及常见文本源码；过滤 .git、node_modules、dist、coverage、.cheese-knowledge、.env*、凭据文件和非普通文件。默认单文件 1 MiB 上限，超限显示 skipped，不伪装完整导入。
- [x] attachWorkspace 幂等创建 project:<workspaceId> 库和 public-basic 库；前者仅本项目可访问，后者为空库起步。解析依赖清单只提出 package 名称/版本及已知官方来源建议，不自动抓取或猜测官网。
- [x] 以 realpath 检查来源根目录与文件；符号链接不跟随，API 只接收 workspace 内相对目录。首次发现清单不导入，不自动将整个工作区纳入来源。
- [x] 首次启用扫描并建立 watcher；add/change/unlink 统一进入按来源串行队列，500ms 去抖，读取→hash→prepare→发布。发布前再次检查 hash；无变化跳过 embedding，unlink 调 deleteDocument。扫描与 watcher ready 后补一次差异同步，覆盖初始化窗口。

```ts
const watcher = chokidar.watch(sourceRoot, {
  ignoreInitial: true, followSymlinks: false,
  ignored: isIgnoredKnowledgePath,
  awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
});
watcher.on('all', (event, path) => {
  if (event === 'add' || event === 'change' || event === 'unlink') {
    queueSourceChange(sourceId, path, event);
  }
});
```

isIgnoredKnowledgePath 在 local-sync.ts 对路径段/文件名应用上述规则；queueSourceChange 合并相同 sourceId+path 的最新事件，按启用来源验证边界后进入单一发布队列。

- [x] 记录 source 的 syncing/ready/error、lastSyncAt、lastError；监听失败不无限重试，保留手动同步入口。close 等待队列收敛并关闭所有 watchers/store。
- [x] 增加 1 个可控同步场景：忽略凭据、hash 相同不重复 embedding、修改/删除生效。直接驱动队列事件，仅一次真实 watcher change 探针，等待有界到 2 秒；不反复扫描真实项目。

**交付:** 已启用来源持续更新；未启用来源只显示建议清单。

## Task 3: Agent 范围、主进程 RPC 和引用检索

**Files:** Create retriever.ts、tools/knowledge-tools.ts、runtime/knowledge-rpc.ts、rag/legacy-runtime.ts；Modify main.ts、runtime/service.ts、worker.ts、worker-client.ts、events.ts、context/prompt-pipe.ts；Extend knowledge-core.test.ts 的第 4 个场景。

**Produces:**

```ts
KnowledgeService.search(ctx: KnowledgeContext, request: SearchRequest): Promise<SearchResponse>;
KnowledgeService.citation(ctx: KnowledgeContext, id: string): CitationView;
KnowledgeService.dispatch(ctx: KnowledgeContext, request: KnowledgeRequest): Promise<unknown>;
createKnowledgeTools(rpc: KnowledgeRpc): ToolDefinition[];
```

CitationView 为 { citation, content, currentRevisionId?, current:boolean }。Library 过滤规则由 libraries.ts 的 resolveLibraries(ctx, query, requestedIds?) 实现，返回可访问 ID 列表；indexKeys 只在服务内部计算。

- [ ] Runtime 持有 KnowledgeService，初始化后 attach 已接入工作区，新增工作区时注册；close 在停止 workers 后关闭知识服务。会话 state.json 维持原结构，索引存在独立 DB。
- [ ] Execution 与 ExecutionOptions 增加 knowledge?: KnowledgeRpc，worker 使用知识 request/result 消息和独立 pending map。首次消息在 import main.ts 前声明 IPC transport，main 顶层不再构造旧 RAG DB。

```ts
// 主进程：可信上下文来自当前执行闭包。
knowledge: request => {
  controller.signal.throwIfAborted();
  return knowledgeService.dispatch({
    workspaceId: workspace.id, workspacePath: workspace.path,
    agentId: session.agentId || 'general', runId: run.id, role,
  }, request);
}
// IPC envelope 不接受 workspaceId/role/agentId。
// {type:'knowledge', id, request}
// {type:'knowledge-result', id, output} 或 {type:'knowledge-result', id, error}
```

role 从当前已解析配置得到，兼容 developer→owner。RPC Zod 解析拒绝额外字段、非法 op、未知引用及不属于可访问库的 libraryIds；超时默认 15 秒，abort/disconnect 拒绝所有 pending，不切回全库。

- [x] legacy-runtime.ts 提供 getLegacyRag()，仅旧 /rag 命令或明确兼容入口首次访问才开旧库；runTask 的新工具不打开旧库。启动横幅/Prompt 改读知识服务摘要，不因统计调用触发 legacy 初始化。
- [x] CLI startAgent 显式创建独立服务，默认目录 cwd/.cheese-knowledge，可用 CHEESE_KNOWLEDGE_DATA_DIR 改址；项目 ID 为规范化路径 hash。REPL/CLI Channel/Cron 注册同样的范围工具，新知识写入不与 Web 数据目录隐式共享；旧 /rag 保留显式 legacy 语义。
- [x] rag_search 的 query/top_k/collection 兼容旧参数；collection 被映射为 libraryId，未知 ID 报错。增加 mode 和 include_graph；rag_ingest 经 RPC 校验目标项目库、角色和已启用本地来源，不允许 worker 任意改写公共库。
- [x] 默认库组合：当前项目库+public basic+当前 Agent 绑定库；manifest knowledge 解析为已存在库 ID，未知 ID显示绑定失效。general 再按名称/描述分词匹配最多 3 个 public domain 库；不为选库增加模型请求。
- [x] query embedding 在读事务前完成；readSnapshot 同步完成范围过滤、searchPrepared 与引用/图证据读取。embedding 无配置或 rag.enabled=false 时 FTS-only，不将 mock 向量作为真实语义检索。
- [x] 输出结构化 SearchResponse 和 knowledge-used 事件，包含 generation、库名/ID、引用 ID、候选状态和更新提示；Prompt 明确区分 code/document/decision/observation/inference。
- [x] 增加 1 个范围/IPC 场景：两个项目使用相同路径、一个 public 库；P1 不能检索/读引用 P2，空可访问范围返回空，伪造 workspace/collection 不扩大范围。复用现有 worker fixture 确认请求经真实 worker 回到主服务，不另起测试框架。graph op 在任务 5 启用前返回明确不可用错误，不回退文本或全库。

**交付:** 领域绑定真正生效、引用可追溯，停止任务不会留下悬挂知识请求。

## Task 4: 资料、来源、绑定和引用页面

**Files:** Create web/knowledge-routes.ts、web/knowledge/controller.js、views.js、citations.js、style.css、docs/engineering-knowledge.md；Modify web/server.ts、web/index.html、web/app.js。

**Produces:** 独立 #knowledge 路由、当前工作区知识管理，以及 Agent 回答中的引用入口。

- [x] 将 API 登记放在 app.all('/api/*',404) 之前，复用现有 Host/Origin/JSON/1 MiB 中间件。以查询/路径 workspaceId 查 Runtime 得到真实上下文，知识 ID 再做作用域检查；未知 ID 返回 404，不回退默认库。

| 接口 | 行为 |
| --- | --- |
| GET/POST /api/v1/workspaces/:id/knowledge/libraries | 列表或创建 public/project 库 |
| GET/POST /api/v1/workspaces/:id/knowledge/sources | 列表或保存指定来源 |
| POST /api/v1/workspaces/:id/knowledge/discover | 返回未启用建议清单 |
| PATCH /api/v1/workspaces/:id/knowledge/sources/:sourceId | enabled、locator、versionConstraint |
| POST /api/v1/workspaces/:id/knowledge/sources/:sourceId/sync | 触发同步，返回作业状态 |
| GET/POST /api/v1/workspaces/:id/knowledge/documents | 分页或导入/创建受管文本 |
| PATCH/DELETE /api/v1/workspaces/:id/knowledge/documents/:documentId | 新版本受管副本或退出当前索引 |
| GET /api/v1/workspaces/:id/knowledge/documents/:documentId/revisions | 版本列表 |
| PUT /api/v1/workspaces/:id/knowledge/bindings/:agentId | 保存库 ID 列表 |
| POST /api/v1/workspaces/:id/knowledge/search | SearchRequest |
| GET /api/v1/workspaces/:id/knowledge/citations/:citationId | CitationView |

所有列表默认 50、最大 100。导入 JSON 使用 {libraryId,path? ,content?,name?}，path 与 content 二选一；path 限已启用来源，content 上限沿用 1 MiB。编辑 local 文档创建 managed Source/副本，保留 derivedFrom，返回明确提示，不修改原源码。

- [x] 注册 /knowledge/*.js 与 /knowledge/style.css 的明确允许名单；未知静态路径返回 404，不能将任意路径传给 readFileSync。仅在既有 app.js 加独立模块导入和路由挂载，既有主题/class 复用。
- [x] 提供库切换、资料列表/编辑、来源清单/同步状态和绑定操作；引用面板纯文本展示原文、1-based 行号、版本状态与当前版本入口。Markdown 展示不执行原始 HTML/脚本。
- [x] 使用 knowledge-used 事件关联回答引用，不只用正则把普通 [1] 文本猜成引用。引用链接包含 citationId，刷新通过 Run 事件恢复。
- [x] 文档说明首次清单启用、自动同步、手动导入、public/project 和 legacy 入口；使用真实服务接口，不写“专属知识库已隔离”占位文案。
- [x] P1 集中检查：运行下面命令一次。测试失败只修相关项并重跑失败文件；不会因这次新增页面补大量 DOM/截图测试。

```sh
npm run build
node --import tsx --test tests/knowledge-core.test.ts tests/rag-collections.test.ts tests/worker.test.ts tests/runtime-agents.test.ts
```

后三个既有文件对应本阶段确实修改的 RAG/worker/agent 契约。若实施最终未触碰其中某契约，可删去对应回归文件，不追加全量 npm test。

**P1 完成:** 接入小项目、启用来源、查询并查看版本引用可用；第 1–4 场景通过后继续 P2。

## Task 5: TS/JS 结构和局部图谱

**Files:** Create code-indexer.ts、graph.ts、web/knowledge/graph.js；Modify schema.ts、store.ts、local-sync.ts、service.ts、tools/knowledge-tools.ts、knowledge-routes.ts、controller.js；Create knowledge-engineering.test.ts 的第 5 个场景。

**Produces:**

```ts
indexCode(workspaceId: string, path: string, content: string): CodeIndex;
KnowledgeService.graph(ctx: KnowledgeContext, entityId: string, hops: 1 | 2): GraphView;
```

CodeIndex 为 {entities: EntityDraft[], edges: EdgeDraft[]}，每个草稿带 SourceSpan，发布时绑定 revisionId。GraphView 为 {generation,nodes,edges,truncated}；EntityDraft 的 key 包含 workspaceId+相对路径+容器+kind+名称。

- [x] 使用安装的 TypeScript 6.0.3 API，仅语法解析 TS/TSX/JS/JSX；提取函数、类、接口、类型、命名箭头函数、导出以及静态 import/export-from。动态非字面量引用不猜测。

```ts
const sf = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKind);
function visit(node: ts.Node): void {
  const start = node.getStart(sf);
  const end = node.getEnd();
  const startLine = sf.getLineAndCharacterOfPosition(start).line + 1;
  const endLine = sf.getLineAndCharacterOfPosition(Math.max(start, end - 1)).line + 1;
  recordSupportedDeclaration(node, {startOffset:start,endOffset:end,startLine,endLine});
  ts.forEachChild(node, visit);
}
visit(sf);
```

recordSupportedDeclaration 仅处理上面列出的节点类型；scriptKind 按扩展名选择 TS/TSX/JS/JSX。按 tsconfig 的 paths/baseUrl 和 ts.resolveModuleName 解析项目导入；包导入指向 package 节点，不索引 node_modules。不创建完整 Program/type checker。

- [x] schema 增加 entities/edges/edge_evidence；import/export/contains 关系来自解析，可直接 effective。自然语言 explains/constrains/contradicts 是模型候选，不能当成解析事实。
- [x] 代码索引与文档发布共用事务；删除旧 revision 的证据归属，仍有当前证据的共享实体/边保留，无当前证据的关系退出当前图。首次启用结构索引对已存在 TS/JS 文档重建一次，后续按 hash 跳过。
- [x] GET /api/v1/workspaces/:id/knowledge/graph?entityId=&hops= 默认 1 跳/60 节点，上限 2 跳/120 节点，所有节点、边、证据遵守 scope；超限返回 truncated。
- [x] 用原生 SVG 和确定性环形/分层布局绘制局部图谱，支持点击、拖动和缩放，不引入力导向模拟。选中实体打开证据；解释按钮填入当前项目会话草稿，不自动运行。
- [x] 加第 5 个合并场景：两个文件同名函数不合并，import 路径/行号准确，修改依赖后旧边退出，共享目标仍存在；候选语义边保留状态，超限显示 truncated，并验证 P1 图查询不能访问 P2 实体和证据。

**交付:** 用户从模块出发浏览真实代码关系及引用，结构解析失败的文件仍可文本检索并显示错误。

## Task 6: 自动沉淀与可信执行记录

**Files:** Create capture.ts、evidence.ts、tools/bash.ts；Modify tools/index.ts、main.ts、schema.ts、service.ts、runtime/service.ts、runtime/events.ts、knowledge-routes.ts、views.js；Extend knowledge-engineering.test.ts 的第 6 个场景。

**Produces:**

```ts
interface CaptureInput {
  runId: string; sessionId: string; workspaceId: string;
  userInput: string; messages: ModelMessage[];
  events: ExecutionEvent[];
  environment: { cwd: string; commit?: string; runtimeVersion: string; modelName?: string };
}
KnowledgeService.enqueueCapture(ctx: KnowledgeContext, input: CaptureInput): void;
KnowledgeService.listItems(ctx: KnowledgeContext, status?: KnowledgeStatus): KnowledgeItem[];
KnowledgeService.correctItem(ctx: KnowledgeContext, id: string, replacement: string): KnowledgeItem;
```

KnowledgeItem 为 {id,kind,status,text,libraryId,evidenceIds,applicability,originRunId?,supersedes?}。CaptureJob 按 runId 唯一；恢复时仅重试提取，不重放工具。

- [x] 把 bash 实现移到 tools/bash.ts，导出 bashTool 和 createBashTool(onEvidence?)；现有 tools/index.ts 重新导出，原工具文本返回和 RBAC/命令分类流程保持。runTask 为实际执行注册带当前 emit 回调的版本。

```ts
interface CommandEvidence {
  executionId: string; command: string; cwd: string;
  exitCode: number | null; timedOut: boolean;
  stdout: string; stderr: string; timestamp: string;
}
const record = (evidence: CommandEvidence) =>
  options.emit?.({type:'execution-evidence', ...evidence});
```

在实际 execSync 成功/失败分支调用 record，executionId 在调用前生成；失败 status=null/timeout 不解释为成功。记录已发生的执行，不为核验额外重跑测试。输出继续走既有脱敏和事件大小限制。

- [x] Runtime 发最终 status 后异步 enqueueCapture，未完成/取消任务不生成成功观察；队列容量默认 20，满时保存 pending 作业稍后处理，不阻塞任务完成，也不占用 Agent 根任务额度。
- [x] 规则提取明确工具观察与用户显式决定，保存原句/事件。模型可每 Run 补充一次结构化候选提取，最大 20 个条目、输入预算 12k tokens、请求时限 15 秒；无模型配置时规则继续可用，失败只记录 capture error，不让已完成 Run 失败。close 取消尚未完成的模型请求，保留可恢复作业，不无限等待。
- [x] 用户原话和前文映射明确才能生效为 decision；命令 exitCode=0 只生效为“该环境的本次执行成功”，不得泛化到架构可靠。其他建议、经验、概念关系默认 candidate；reasoning 不参加提取。
- [x] Item 的 evidenceIds 指向不可变原文版本或脱敏事件快照，capture 信息项目私有。来源变更使相关观察/经验 needs_review，用户决定仅在明确纠正/替代时失效。
- [x] POST /api/v1/workspaces/:id/knowledge/items/:itemId/correct 用新文本替代旧条目；POST .../share 需显式选择目标 public 库。candidate 手动发布要附原始依据或标记为用户认可的经验，不伪装外部事实。
- [x] 第 6 个合并场景：同 run 去重、用户明确决定生效、歧义推荐仍候选、exitCode=0 的观察保持环境范围、超时/返回错误文本不生效、模型自证链拒绝成为核验依据。

**交付:** 使用经验持续进入知识中心，引用能解释条目为何生效。

## Task 7: 沉淀页面、纠错和候选隔离

**Files:** Modify libraries.ts、retriever.ts、service.ts、knowledge-routes.ts、web/knowledge/views.js、citations.js、graph.js、docs/engineering-knowledge.md。

- [x] GET /api/v1/workspaces/:id/knowledge/items 分页列出状态、来源和适用范围；页面提供候选/生效/待复核/失效筛选、证据查看、编辑纠正和明确分享操作。
- [x] fact 模式只构造 effective 内部分区；experience 才加入 candidate 分区。needs_review/invalidated 默认退出，两种模式都不能悄悄恢复。所有候选引用带“待验证”文字，关系显示虚线及状态。

```ts
const statuses: KnowledgeStatus[] =
  request.mode === 'experience' ? ['effective', 'candidate'] : ['effective'];
const indexKeys = resolveIndexKeys(accessibleLibraryIds, statuses);
if (indexKeys.length === 0) return emptySearchResponse();
```

resolveIndexKeys 定义在 libraries.ts，将服务已允许库 ID 和状态映射到内部 collection_id；emptySearchResponse 返回当前 generation、空 hits、实际空库列表。

- [x] 纠错在单事务内使旧条目 invalidated、更新向量/FTS、建立 supersedes/invalidates，并更新相关边；历史原引用仍展示“已失效”，正式检索只返回替代条目。
- [x] P2 集中运行一次构建与工程场景；若 bash 抽取改变了现有工具返回，再补跑 tool-integration.test.ts，否则不扩大。

```sh
npm run build
node --import tsx --test tests/knowledge-engineering.test.ts
```

**P2 完成:** 结构图谱及沉淀可用，第 5–6 场景通过后继续 P3。

## Task 8: 有界跨文档关系查询

**Files:** Modify retriever.ts、graph.ts、service.ts、tools/knowledge-tools.ts、context/prompt-pipe.ts；Create knowledge-query.test.ts 的第 7 个场景。

**Produces:** SearchRequest.includeGraph=true 时的同 generation 邻接证据召回；knowledge_graph 工具可显式探索已允许实体。

- [x] 文本/符号召回前 5 个种子，最多沿有效 contains/imports/exports 2 跳；effective explains/constrains 可补充证据。experience 才可沿候选语义边，并保留候选标签。图扩展最多增加 10 个片段，最终返回 topK≤20。
- [x] query embedding 先完成，再由 readSnapshot 同步组合文本、关系及证据，禁止 await 在 SQLite 读事务内。所有分支都基于已计算的访问范围。

```ts
return store.readSnapshot(generation => {
  const seeds = searchPreparedWithinScope(request, queryVector, allowedLibraries);
  const related = request.includeGraph
    ? graphEvidenceWithinScope(seeds, allowedLibraries, request.mode, 2, 10)
    : [];
  return buildSearchResponse(generation, allowedLibraries, seeds, related);
});
```

searchPreparedWithinScope 调用任务 1 的 searchPrepared；graphEvidenceWithinScope 使用任务 5 的图存储且只扩展当前证据；buildSearchResponse 合并 chunkId 去重、排名、截断并生成 Citation。

- [x] Prompt 使用独立 code/document/decision/observation/inference 标识，要求结论关联引用；资料中的命令文本不成为执行指令。不建立“模型识别冲突即自动纠正源码”的流程。
- [x] 第 7 个合并场景用可控源码、设计文档和决定，验证联合召回、同 generation、候选状态、跨项目边不越界及纠错后旧结论退出。mock 回答只用于接口演示，不作为模型推理质量证明。

**交付:** 首个问题可通过代码关系补充文档依据，支持多文档引用；影响分析和完整调用图仍是后续范围。

## Task 9: 公开资料适配、兼容入口和完成交付

**Files:** Create providers.ts；Modify sources.ts、service.ts、knowledge-routes.ts、views.js、docs/engineering-knowledge.md；Extend knowledge-query.test.ts 的第 8 个场景。

**Produces:**

```ts
interface ProviderDocument {
  sourceKey: string; sourceUrl: string; content: string;
  version?: string; fetchedAt: string; provider: 'context7' | 'firecrawl';
}
interface PublicSourceProvider {
  fetch(source: Source, signal: AbortSignal): Promise<ProviderDocument[]>;
}
```

- [ ] 服务端适配器读取 CONTEXT7_API_KEY/FIRECRAWL_API_KEY，UI 只显示是否可用。实现前只查所需 endpoint 的当前官方文档，不凭记忆编造 SDK/API 字段，不把整个文档库研究一遍。
- [ ] Context7 根据已选 library/version/query 请求文档，结果先展示；只有明确保存才作为 Source 文档发布，保留每段 source URL。Firecrawl 只同步来源指定 host/path，默认单次最多 30 页，异步 crawl 状态有界轮询、总时限 60 秒，取消会退出，不自动跟随外站。
- [ ] 外部来源启用后默认手动首次同步，可设置每 24 小时更新；使用服务内部定时器，不触发 Agent Cron。内容 hash 未变不重建；网络/凭据失败记录 lastError，保留旧版并标明 lastSyncAt。
- [ ] 第 8 个合并场景用本地 HTTP 夹具验证 URL/版本保存、禁止外站、本地内容不上传、同 hash 跳过、失败保留旧数据及候选纠错失效。测试不调用真实服务，不检查 SDK 自身功能。
- [ ] 增加手动“导入旧知识库”入口：仅读旧 chunks/source/collection，复制到当前项目 legacy 库；source 可读取时重新生成 span，不能读取时保存旧文本且版本/位置未知。旧库不清空，无法追溯的材料不能生成精确源码引用。
- [ ] 补齐用户说明：首发 TS/JS 范围、缺少 embedding/在线服务时的 FTS-only、本地资料与受管副本、同步故障、候选、生效规则、历史证据、CLI 与 Web 数据目录区别。
- [ ] P3 集中检查一次；此前阶段通过的文件不默认重复运行。

```sh
npm run build
node --import tsx --test tests/knowledge-query.test.ts
```

- [ ] 做一次人工烟雾路径：小项目接入→清单启用→提问“某模块如何工作”→查看源码/文档引用→局部图谱→查看候选→纠正条目。只记通过/失败与必要原因，不生成截图矩阵或另做全面 QA。
- [ ] 一次 diff 自查与文档更新后交付。实际失败必须修复；全部通过后停止验证，不为提高覆盖率或打分再添加检查。

**P3 完成:** 首个工程理解闭环交付，跨文档关系检索可用，公开来源可选。不宣称已完成跨语言影响分析或真实模型评测。

## 4. 最小夹具和断言约定

tests/helpers/knowledge-fixture.ts 用 node:fs 的 mkdtempSync 创建临时资料目录，构造 KnowledgeService({dataDir,embedderForWorkspace:()=>createMockEmbedder()})；通过 t.after 调用 service.close() 后清理仅该临时目录。先建 p1/p2 和 public 库，再写 3 个小文件，不复制真实仓库。

夹具的 seedDocument(ctx, libraryId, path, content) 使用 store.createSource(kind:'managed') 与 publishRevision；seedRun(ctx,input) 调 enqueueCapture 并等待该 runId 的作业状态；只用于测试、实现在同一个 helper 文件。核心数据测试直接构造 KnowledgeStore，服务测试通过正常方法查询；不为检查版本额外增加生产测试专用接口，生产 API 不公开任意 DB 操作。

关键断言覆盖以下结果，不测试字段顺序或内部 helper 调用次数：

```ts
assert.ok(response.hits.every(hit => allowedCitationIds.has(hit.citation.id)));
assert.equal(response.hits.some(hit => hit.citation.status === 'candidate'), false);
assert.equal(oldCitation.current, false);
assert.equal(oldCitation.content, originalSource);
assert.equal(graph.edges.some(edge => edge.id === obsoleteEdgeId), false);
assert.equal(items.filter(item => item.originRunId === runId).length, expectedItemCount);
```

允许测试 hash 未变化时 embedding 计数不增加，这是实际费用/同步行为；禁止单独测试 DTO 字段存在、按钮配色、getter/setter 等实现细节。

## 5. 后续接手与执行原则

- 阅读 spec 和当前源码定位后直接按任务实现，不重新进行产品访谈。
- 技术小选择由主代理自行完成；偏离已确认范围才提出具体差异。
- 在阶段任务中写必要测试，但集中到阶段末运行；不用机械先红后绿或每小任务独立 review。
- 测试耗时异常先缩小夹具/排除真实网络，不能靠反复重跑等待通过。
- 索引、范围和证据关键检查完成即可交付，不把“更完整验证”作为默认追加工作。
- 计划生成本身不执行 build/npm test，不自动 commit 或启动开发。

## 6. 需求覆盖

| 设计要求 | 对应任务 |
| --- | --- |
| R01、R04、R14 有出处的工程理解 | 1、3、4、5、8 |
| R02、R06、R11 多对多绑定及公共/项目范围 | 1、3、4、7 |
| R03、R08、R13 导入编辑与来源清单/公开资料 | 2、4、9 |
| R05、R10 自动沉淀与候选状态 | 6、7、8 |
| R07 变化同步与引用有效性 | 1、2、3、5 |
| R09、R12 代码结构和局部图谱 | 5、7 |
| R15 渐进交付和跨文档查询 | P1/P2/P3、8 |
