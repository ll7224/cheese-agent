# 工程知识中心架构与使用指南 (Engineering Knowledge)

Cheese Agent 提供面向本地工程研发的多租户工程知识中心，支持源码及规范资料的版本化索引、自动同步、智能体绑定与不可变引用溯源。

---

## 1. 架构总览与知识库划分

知识中心采用 SQLite + 混合向量/全文检索架构，统一管理工作区内的工程资料与跨项目公共知识。

### 知识库作用域 (Scope) 与角色 (Role)

| 知识库 ID 规则 | 作用域 (Scope) | 角色 (Role) | 访问与写入规则 |
| --- | --- | --- | --- |
| `project:<workspaceId>` | `project` | `project` | **项目专属库**。仅当前工作区可检索与写入；存放项目源码、架构决策与受管文档副本。 |
| `public-basic` | `public` | `basic` | **公共基础库**。所有工作区默认可检索；仅管理员或初始化流程可写入。 |
| `pub-...` | `public` | `domain` | **公共领域库**。存放特定领域（如前端组件库、后端规范等）知识，由 Agent 显式绑定或通用助手语义匹配。 |

### 严格租户隔离机制

系统通过 `resolveLibraries()` 在读写事务前完成范围解析：
- 项目 P1 绝对无法检索、读取或引用项目 P2 的专属库文档，即使两者使用相同的相对路径（例如 `docs/architecture.md`）。
- 检索与引用溯源接口严格验证 `libraryId`，未知或未授权的 ID 直接返回 404/拒绝，绝不静默回退到全库或默认库。

---

## 2. 来源管理与首次清单启用

知识来源（Source）表示知识中心摄入资料的源头。

### 自动发现建议 (Discovery)

首次接入项目文件夹时，系统自动扫描工作区根目录与规范目录（例如 `docs/`、`src/`、`README.md` 等），生成建议清单：
```http
POST /api/v1/workspaces/:workspaceId/knowledge/discover
Content-Type: application/json

{}
```
返回候选列表，包含定位符 (`locator`) 与推荐理由。

### 启用本地来源

选择启用建议来源或手动添加本地来源：
```http
POST /api/v1/workspaces/:workspaceId/knowledge/sources
Content-Type: application/json

{
  "libraryId": "project:ws-abc",
  "kind": "local",
  "locator": "docs",
  "enabled": true
}
```
- `kind`: `local`（工作区相对路径）或 `managed`（受管文档）。
- 安全沙箱约束：系统使用 `fs.realpathSync` 验证目标绝对路径不能越出工作区根目录；符号链接不跟随；忽略凭据与 `.git`、`node_modules` 目录；单个文件上限 1 MiB。

---

## 3. 增量监听与自动同步

启用本地来源后，`LocalSyncManager` 会在后台启动文件系统监听：
- **去抖聚合**: 默认 500ms 去抖缓冲，防止编辑器频繁保存造成并发写冲突。
- **原子版本发布**: 每次文件变动生成新不可变版本 (`Revision`)，分块及索引更新在同一个 SQLite 事务中完成，并递增全局 `generation` 快照版本。
- **手动触发同步接口**:
  ```http
  POST /api/v1/workspaces/:workspaceId/knowledge/sources/:sourceId/sync
  Content-Type: application/json

  {}
  ```

---

## 4. 手动资料导入与受管副本

除了工作区现有文件外，还可以直接导入独立文本（如架构决议、会议备忘、排障经验）：

### 导入文档

```http
POST /api/v1/workspaces/:workspaceId/knowledge/documents
Content-Type: application/json

{
  "libraryId": "project:ws-abc",
  "name": "adr-001-database-choice.md",
  "content": "# ADR 001: 选用 SQLite 作为知识中心底层存储\n..."
}
```
- 约束：仅允许向当前工作区的专属项目库导入；`path` 与 `content` 二选一；`content` 上限 1 MiB；`path` 必须位于已启用的本地来源范围内。

### 本地文档安全编辑（受管副本机制）

通过 Web 界面或 API 编辑来自 `local` 源码的文档时：
```http
PATCH /api/v1/workspaces/:workspaceId/knowledge/documents/:documentId
Content-Type: application/json

{
  "content": "更新后的文档内容..."
}
```
**系统保护原则**: 不直接覆盖本地磁盘上的原始源码文件，而是在当前项目库中自动创建带有 `derivedFrom` 标记的受管副本 (`managed` Source)，既满足用户知识订正需求，又避免意外污染源码树。

---

## 5. 智能体绑定 (Agent Bindings)

不同的智能体（如安全审查员、数据库架构师）可以绑定不同领域的知识库：
```http
PUT /api/v1/workspaces/:workspaceId/knowledge/bindings/:agentId
Content-Type: application/json

{
  "libraryIds": ["project:ws-abc", "public-basic", "pub-domain-security"]
}
```
- 通用助手 (`general`) 默认包含项目库 + 基础库，并在请求时按词义匹配最多 3 个公共领域库。
- 绑定接口严格校验库 ID 存在性，未知库 ID 直接报错。

---

## 6. 引用溯源与 Citation 协议

模型在回答中调用 `rag_search` 时，系统自动发射 `knowledge-used` 运行时事件，记录命中片段的元数据：
```json
{
  "type": "knowledge-used",
  "generation": 42,
  "libraryIds": ["project:ws-abc"],
  "citations": [
    {
      "citationId": "ref-xyz",
      "libraryId": "project:ws-abc",
      "documentId": "doc-123",
      "revisionId": "rev-456",
      "sourceUri": "docs/architecture.md",
      "status": "effective",
      "evidenceKind": "document"
    }
  ]
}
```

### 前端引用面板

用户点击回答底部的引用徽章时，调用接口：
```http
GET /api/v1/workspaces/:workspaceId/knowledge/citations/:citationId
```
面板提供：
1. **纯文本原文查看**: 严格转义 HTML，绝不执行外部脚本。
2. **1-based 行号标记**: 精确高亮 `startLine` 到 `endLine` 行范围。
3. **版本状态感知**: 标注该引用是当前生效版本还是已被后续提交替代的历史版本（附带生效版本入口与 SHA-256 Hash）。

---

## 7. 兼容与旧版 (Legacy) 入口

- **按需惰性初始化**: 系统移除启动时急迫的 `new SqliteVectorStore('knowledge.db')` 调用。
- **旧命令兼容**: 仅在 CLI 中显式调用旧版 `/rag` 命令时，才通过 `getLegacyRag()` 惰性连接旧版数据库。
- **Agent 工具与 Web 路由**: 全面使用新的统一 `KnowledgeService`，彻底避免未经授权的全局 SQLite 句柄污染。
