# 工程知识中心设计

日期：2026-10-13。状态：访谈范围已确认，实施计划已生成；尚未实施。

实施计划：[工程知识中心 Implementation Plan](../plans/2026-10-13-engineering-knowledge.md)。

## 1. 用户要求与开发约束

用户最新要求：“生成对应的plan，但是要尽量减少在验证投入的时间，这点要切记，后续的开发也需要这样，不要过度校验。”

- 验证只覆盖本次改动的关键行为和实际风险，通过后停止。
- 不为每个小改动、展示细节或内部辅助函数新增测试。
- 每阶段集中运行一次相关测试和一次构建；失败后仅重跑受影响项。
- 不默认运行全量测试、多轮审查、性能压测、付费模型评测或浏览器截图矩阵。
- 后续开发继续遵守最小必要验证；发现具体问题才扩大检查范围。
- 子代理只做只读探索、定位和核验；代码修改、方案取舍和最终验证由主代理负责。
- 源码模块以 300–500 行为目标，新功能独立成模块；既有大文件只接入小入口，不追加功能主体。

这些约束优先于技能中的逐任务 TDD、双阶段审查和重复验收模板。

## 2. 已确认产品范围

| ID | 已确认决策 |
| --- | --- |
| R01 | 首版以有出处的工程回答和知识管理为目标，后续支持跨文档关系推理。 |
| R02 | 知识库独立于 Agent，多 Agent、多知识库之间可以多对多绑定。 |
| R03 | 保留人工导入与编辑入口；外部资料补足知识，聊天和任务结果持续沉淀经验。 |
| R04 | 首个领域是项目代码工程知识，首个任务是理解模块如何工作、设计依据和实现是否一致。 |
| R05 | 明确用户决定、可核验执行结果按适用范围自动生效；其他总结和推断进入候选。 |
| R06 | 公共资料全局共享；项目约定和执行经验默认属于当前项目，可主动提升为共享知识。 |
| R07 | 本地文件自动增量更新；回答时检查引用来源是否变化，显示待更新状态。 |
| R08 | 项目文件在本机同步；公开官方资料可以使用 Context7、Firecrawl 等在线服务。 |
| R09 | TS/JS 建立模块、符号位置、导出和 import 关系；其他文本源码、Markdown、TXT 支持文本检索。 |
| R10 | 正式结论默认使用已生效知识；查经验或排障时可引用候选，必须标注待验证及其依据。 |
| R11 | 当前项目知识、公共基础库和绑定领域库自动组合；通用 Agent 按任务选择领域库，并显示本轮范围。 |
| R12 | 图谱默认展示模块附近关系，点击节点查看证据或发起解释；全项目概览为辅助。 |
| R13 | 选择项目后发现资料和依赖，生成可编辑来源清单；启用清单后持续同步。 |
| R14 | 原文、版本和引用位置可追溯；区分设计意图、当前实现、运行证据及候选推断。 |
| R15 | 先完成资料检索闭环，再加入工程图谱与沉淀，最后加入有界跨文档关系查询。 |

## 3. 技术基线与接入事实

- 现有 Hono + 原生 HTML/CSS/JS + SSE 和 Runtime/worker 保留，不与历史 React 迁移计划绑定。
- Agent 的 knowledge 字段已存在，但 runTask 未将其自动应用到检索：src/agents/manifest.ts:35、src/main.ts:398、src/tools/rag-tools.ts:53。
- SqliteVectorStore 已提供向量 + FTS + MMR 混合检索；当前 chunk ID 是 source#index，没有文档版本和原文偏移：src/rag/sqlite-store.ts:17、src/rag/chunker.ts:110。
- worker 导入 main.ts 时会构造工作目录中的 knowledge.db，同项目多个 worker 可能并发打开它：src/main.ts:95、src/runtime/worker.ts:25。
- Cron 的请求/响应 IPC 可作为知识请求接入模板：src/runtime/worker-client.ts:30、src/runtime/worker.ts:6。
- Runtime 已有任务、消息和工具事件；现有 memory 缺少候选状态、证据链和失效关系：src/runtime/service.ts:353、src/memory/store.ts:6。
- web/app.js 与 web/style.css 已超过 2,000 行；新界面放独立模块，现有文件只负责路由和挂载。

以上定位是规划依据，不代表本次已完成实现或运行测试。

## 4. 架构与数据

新增主进程 KnowledgeService，集中管理来源同步、索引发布、范围解析、图查询和知识沉淀。Web API 和 worker IPC 都调用同一服务。独立 CLI 使用同一服务实现，保存到自己的明确数据目录，不管理 Web 服务的数据目录。

知识数据单独保存到服务 dataDir 下的 knowledge-center.db，原文版本保存在 revisions 表，来源凭据单独引用配置。会话 state.json 不迁移。旧工作目录 knowledge.db 原位保留；手动导入旧库到当前项目 legacy 库，并将无法恢复的版本/行号标为未知，不自动清空旧库。

| 实体 | 关键身份与字段 |
| --- | --- |
| Library | id、scope(public/project)、workspaceId、名称、描述、角色(basic/domain/project/legacy) |
| Source | id、libraryId、kind(local/managed/capture/context7/firecrawl)、locator、enabled、同步状态、版本约束 |
| Document | id、sourceId、规范化 sourceKey、activeRevisionId、deletedAt |
| Revision | id、documentId、原文、hash、commit、时间、generation、来源属性 |
| ChunkRef | chunkId、revisionId、原文行号/偏移、内部索引分区 |
| Entity | scope 内稳定身份、类型(file/module/symbol/concept)、名称、位置 |
| Edge | 类型、起止实体、状态、证据引用；同一关系可有多个来源 |
| Item | 类型(decision/observation/experience)、状态、内容、适用范围、证据和替代关系 |
| Binding | workspaceId + agentId 对应的 libraryIds，可覆盖 manifest 的默认绑定 |
| CaptureJob | runId、去重键、处理状态和最后错误 |

新 chunkId 使用 documentId + revisionId + index，不复用 source#index。符号身份包含 workspace、文件、容器、类型和名称；改名先按删除旧身份/新增新身份处理，不建设复杂追踪算法。

## 5. 索引、引用和更新

1. 发现并启用来源；本地仅读取来源根目录内的普通文本文件，忽略 .git、node_modules、构建输出、二进制、.env 和凭据文件。
2. 读取原文、计算 hash，保留 commit 和未提交内容的 hash；hash 未变化时跳过解析和 embedding。
3. 分块保留原文 span；TS/JS 同时提取语法结构。embedding、网络调用和解析在写事务之外完成。
4. 单一写入队列在事务内替换当前 chunks/vector/FTS、更新文档 activeRevisionId、图证据和 generation；陈旧作业不能覆盖较新来源版本。
5. 原文版本和历史引用保留。删除来源文档后退出当前检索，其派生条目标为待复核；已撤销访问范围的历史证据也不可被原引用绕过。

每次检索及其图扩展读取同一已发布 generation，并返回不可变引用。一个 Run 的多次检索若跨越更新，可引用不同版本，回答必须显示版本/当前或历史状态；首版不实现整次 Run 固定数据库快照。

原文变更后，旧证据不会自动成为新版本证据。引用查看默认打开被引用版本，提供当前版本链接；历史版本缺少时明确提示不可追溯，不能伪造行号。

## 6. Agent 检索与沉淀

范围由主进程根据真实 Run/Session/Workspace、Agent 定义和 Binding 计算。worker 仅发送检索意图，不能自报 workspaceId 或扩大权限。

领域 Agent 使用当前项目库、公共基础库和绑定库。general 先使用当前项目与公共基础库，再按库名称/描述关键词选最多 3 个领域库；用户可显式调整可访问库。作用域限制应用于向量、FTS、图遍历、证据读取、缓存和写入入口。

候选使用独立索引分区。事实问答不召回候选；experience 模式可召回候选并携带状态。用户纠正建立 supersedes/invalidates，旧条目退出正式检索。

任务完成后异步提取，不阻塞 Run 完成；按 runId 去重。规则先处理结构化证据，模型仅补充提取：

- 明确用户决定必须有原话与上下文映射；“按推荐”无法唯一指向选项时保留候选。
- 执行结果必须有可确认的命令/结果状态、工具事件和运行环境；任务 completed 或 tool-result 本身不证明命令成功。
- 当前 bash 工具错误也可能返回文本，因此未增加结构化执行证据前，其输出不能自动成为成功观察。
- 模型置信度、推理文本、知识条目自身派生摘要不能作为独立核验依据。
- 保存环境快照仅包含版本、命令、路径与非敏感配置，不记录凭据。
- 公共分享由用户明确操作，并保留原项目来源与范围变更记录。

## 7. 来源与界面

本地发现 README、docs、AGENT/AGENTS、src、配置/依赖清单；先输出清单再启用，不把启动发现等同于全库写入。读取 package.json/锁文件得到实际依赖，提出官方来源建议，无法确定官网时不猜测域名。

Context7 用于按需文档查询，选定内容才能进入持久库。Firecrawl 采集已启用的公开来源，限定站点/路径，保存原始 URL、抓取时间、hash 和版本标签。首版禁止把本地源码上传给采集服务。外部资料手动首次同步，之后可配置周期；定时错误保留上次成功数据并显示 lastError，不自动扩大来源。缺少服务凭据不会妨碍本地知识闭环。

知识中心提供资料、来源、沉淀、图谱四个入口；独立于 Agent 详情。资料支持手动创建、导入、编辑、删除和版本查看。编辑导入资料形成受管副本，不静默改写原仓库；源码编辑继续交给原文件工具，知识中心跟随同步。

局部图谱默认 1 跳、最多 60 节点，手动展开最多 2 跳/120 节点；明确显示截断。节点显示类型、状态、来源，候选连接用虚线并带文字状态。证据面板展示行号、版本和原文。“解释此模块”向当前项目会话填入问题并附实体 ID，不自动提交任务。

## 8. 首版和后续边界

首版包括资料管理、来源同步、Agent 绑定及范围显示、引用、TS/JS 结构、局部图谱、自动沉淀和最多 2 跳的关联检索。修改影响分析、完整调用图、数据流、多语言结构解析、PDF/Word/OCR、图社区摘要、Neo4j、React 迁移、远程多用户不属于本计划。

## 9. 最小必要验证

三个阶段各集中验证一次，合并夹具覆盖 8 个关键场景：版本替换/删除、索引失败保留旧版、范围过滤与 IPC 上下文、来源更新、符号与图证据、沉淀状态/幂等、纠错失效、跨文档引用。

复用 node:test、临时目录、mock embedding 和本地夹具。UI 在最后做一次“接入—查询—引用—图谱—候选”人工烟雾检查；不加浏览器矩阵。全量 npm test 不作默认门槛；共享 Runtime/worker 契约变动时补跑现有相关测试文件即可。

本次文档生成只做一次内容/链接/差异检查，不运行应用测试。通过后不再派审查代理，也不重复运行相同检查。

## 10. 参考

- [Dify](https://github.com/langgenius/dify)：知识库、文档和分块管理。
- [LightRAG](https://github.com/HKUDS/LightRAG)：实体/关系与来源证据组织。
- [GraphRAG](https://github.com/microsoft/graphrag)：后续复杂整体语料查询参考。
- [Context7](https://context7.com/docs/api-guide)、[Firecrawl](https://docs.firecrawl.dev/)：公开资料查询与采集。
- [TypeScript Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API)、[Chokidar](https://github.com/paulmillr/chokidar)：结构解析与文件监听。实现以安装的 TypeScript 6.0.3 类型声明为准，不混用主分支新 API。
