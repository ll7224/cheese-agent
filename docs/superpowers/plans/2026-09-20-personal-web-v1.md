# Personal Web Workbench v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 本工作区子代理仅用于探索/核验，不委派代码修改；主代理负责实现和最终验证。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在已存在的本地 Web 工作台上交付本任务确认的文档/编码、单任务、可审批、可查看文件的个人 v1。

**Architecture:** 复用 Hono、Runtime、持久化事件与 fork worker，增加准入模式、会话整理、审批和文件服务。将原生页面迁移至 React + Vite，保持同源 HTTP/SSE 和现有恢复语义。

**Tech Stack:** TypeScript、Node.js（按现有文档使用 24 LTS）、Hono、React、Vite、node:test；SQLite 服务锁和 JSON 快照沿用。

**Spec:** [2026-09-20-personal-web-v1-design.md](../specs/2026-09-20-personal-web-v1-design.md)

## Global Constraints

- 个人本机使用，命令启动 Web 服务并打开浏览器；保留 CLI。
- Web 服务全局一次运行一个根任务，忙时拒绝新提交，不自动排队；可查看其他历史和编辑草稿。
- 页面关闭不取消；重连补发事件；进程退出后未完成任务中断，不自动重跑。
- 停止任务及其子任务，保留文件修改与记录；待任务收敛后才能发送下一条。
- 审批不是沙箱，cwd 不是权限边界。
- 现有文档、未提交 service-lock 修复与测试不覆盖、不回退；本轮仅规划，以下任务均未执行。
- 不在实施过程中增加 PDF/Word、根任务队列、配置中心、编辑器或回滚。

## 0. 执行前检查与文件责任

先读 Spec 与现有 `docs/specs/2026-09-18-local-agent-ui.md`，确认本任务差异；记录 `git status --short`。当前已存在未提交修改：`docs/local-web-workbench.md`、旧 spec、验收记录、`src/runtime/service-lock.ts` 与 `tests/service-lock.test.ts`。需要改使用文档时保留这些改动，不将其混入本任务提交。记录 `npm run build`、`npm test` 的新基线，旧验收次数不可冒用。

| 文件 | 责任 |
| --- | --- |
| `src/runtime/service.ts` | 状态兼容、单任务准入、会话更新/查询、托管目录、审批协调 |
| `src/runtime/approvals.ts`（新） | 审批记录和一次性决策，私有等待器不持久化 |
| `src/runtime/events.ts` | 审批/变更/未知结果事件、执行授权回调契约 |
| `src/runtime/worker.ts`、`worker-client.ts` | 审批 IPC、终止时释放等待器 |
| `src/security/operation-policy.ts`（新） | 最终工具输入的允许/询问/拒绝决策 |
| `src/security/workspace-paths.ts`（新） | 文件规范化、根范围校验、安全打开 |
| `src/security/shell-runner.ts`（新） | 受限进程执行接口、取消与输出限制 |
| `src/security/platform-sandbox.ts`（新） | 当前平台的实际写入限制，能力探测失败关闭 |
| `src/tools/registry.ts`、`src/tools/index.ts`、`src/main.ts`、`src/agents/spawn.ts` | 统一工具授权/上下文传递及真实执行接入 |
| `src/web/files.ts`（新）、`server.ts` | 文件/会话/审批 API，现有同源保护 |
| `src/web/open-browser.ts`（新）、`src/index.ts` | 启动后打开浏览器，支持 no-open |
| `web/src/{App,SessionList,Conversation,ExecutionTimeline,ApprovalCard,FilePanel}.tsx`（新） | 页面与 UI 行为 |
| `web/src/{api,events}.ts`、`web/vite.config.ts`、`web/tsconfig.json`（新） | API 类型、去重事件、构建与类型检查 |
| `tests/*.test.ts` | 公开行为、权限边界、真实 worker 和恢复回归 |

以下代码是约束和关键测试骨架；未列出的现有 API 保持兼容，不把孤立样例当成完整实现。

## Task 1：旧快照兼容与个人模式准入

**Files:** 修改 `src/runtime/service.ts`、`src/web/server.ts`；新增 `tests/personal-admission.test.ts`，扩展 `tests/storage.test.ts`。

**Interfaces:** Runtime 构造 options 增加 `admission?: 'queued'|'single-reject'`；`startWeb` 传入 single-reject。保留 `submit(sessionId,text,key): Run`。Session 增加 `archivedAt?: string`，Run 增加 waiting_approval，State 增加 `schemaVersion?: 2` 与 `approvals?: Approval[]`（Task 4 定义）。

- [ ] 添加忙碌拒绝且消息无变化的测试（临时目录沿用 tests/runtime.test.ts 的 finally 清理）：

```ts
const runtime = new Runtime(dir, async ({ messages }) => {
  await gate; return messages;
}, { admission: 'single-reject' });
const workspace = runtime.addWorkspace(dir);
const first = runtime.createSession(workspace.id);
const second = runtime.createSession(workspace.id);
const run = runtime.submit(first.id, 'one', 'key-1');
assert.equal(runtime.submit(first.id, 'one', 'key-1').id, run.id);
assert.throws(() => runtime.submit(second.id, 'two', 'key-2'), /忙/);
assert.equal(second.messages.length, 0);
assert.equal(runtime.state.runs.length, 1);
release(); await runtime.idle();
```

`gate` 用 `new Promise<void>(resolve => { release = resolve; })` 创建，release 在 finally 中也调用，避免失败后挂起。

- [ ] 运行 `node --import tsx --test tests/personal-admission.test.ts`，确认因尚未实现行为失败。
- [ ] 将幂等检查保留在全局忙碌检查前，准入检查在任何状态写入前；个人模式有效根额度固定 1，不能由 CHEESE_MAX_RUNS 提高。关键判断：

```ts
const occupied = this.state.runs.some(run =>
  ['queued', 'running', 'waiting_approval', 'stopping'].includes(run.status));
if (this.options.admission === 'single-reject' && occupied)
  throw new RuntimeError('服务忙，请等待当前任务结束', 409);
```

保留 legacy 排队模式供原调用；个人模式不对用户产生 queued 状态。检查 close/recovery/active 的所有状态集合。旧数据补 schemaVersion/approvals，未知高版本拒绝，首次升级留备份；不重排旧事件序号。
- [ ] 验证两次同步提交也只接受一次；waiting_approval/stopping 阻止新任务；恢复旧 queued 不执行；单模式 Channel/Cron 忙碌报错，旧模式原并发测试仍通过。运行新测试、storage 与 adapters 测试后，提交本任务文件。

## Task 2：会话整理与托管目录

**Files:** 修改 `src/runtime/service.ts`、`src/web/server.ts`；新增 `tests/session-management.test.ts`。

**Interfaces:** `Runtime.updateSession(id, patch: {title?: string; archived?: boolean}): Session`；`Runtime.listSessions(workspaceId, options: {q?: string; archived?: boolean; offset?: number; limit?: number}): Session[]`；`Runtime.createManagedWorkspace(): Workspace`。API 使用 Spec 第 7 节路径，返回 Session 时不泄露配置密钥。

- [ ] 编写新快照重启后标题和归档保留、搜索先于分页的测试：

```ts
runtime.updateSession(session.id, { title: '文档整理', archived: true });
assert.equal(runtime.listSessions(workspace.id, { q: '文档' }).length, 0);
assert.equal(runtime.listSessions(workspace.id, { q: '文档', archived: true })[0].id, session.id);
assert.throws(() => runtime.submit(session.id, 'run', 'archived'), /归档/);
```

- [ ] 运行 `node --import tsx --test tests/session-management.test.ts`，确认行为失败。
- [ ] 在 Runtime 校验 patch，只接受 title/archived，标题 trim 后 1–100 字符，拒绝空 patch/未知字段；活跃任务禁止归档。更新时持久化并维护 updatedAt；列表 q 做大小写不敏感子串匹配，不把用户输入当正则。自动目录按 `join(dataDir,'workspaces',randomUUID())` 创建 0700，复用 addWorkspace 规范化；仅清理本次空目录。
- [ ] 用 app.request 覆盖 PATCH、无效输入、409、取消归档、默认隐藏归档、跨目录搜索隔离；两次创建托管目录得到不同路径且可写。运行新测试、runtime/storage，提交。

## Task 3：统一授权入口与 Shell 边界探针

**Files:** 新增 `src/security/{operation-policy,workspace-paths,shell-runner,platform-sandbox}.ts`；修改 `src/tools/{registry,index}.ts`、`src/main.ts`、`src/runtime/events.ts`、`src/agents/spawn.ts`；新增 `tests/operation-policy.test.ts`、`tests/sandbox-boundaries.test.ts`。

**Interfaces:** 在 operation-policy.ts 定义 `Operation {toolCallId: string; toolName: string; input: unknown; cwd: string; childRunId?: string}`、`PolicyDecision = {kind:'allow'} | {kind:'deny'; reason:string} | {kind:'ask'; reason:string; targets:string[]}`、`evaluateOperation(op: Operation): Promise<PolicyDecision>`。定义 `authorize(op: Operation, signal: AbortSignal): Promise<void>` 执行钩子。`runShell({command,cwd,signal,writeRoots}): Promise<{stdout:string;stderr:string;exitCode:number}>`；拒绝未验证 sandbox 后端。

- [ ] 先用真实临时工作目录/外部哨兵文件写失败测试：目录内写入成功，Shell 重定向、解释器写文件、符号链接和子进程写外部哨兵都失败，哨兵字节保持一致。测试代码形态：

```ts
await assert.rejects(runShell({ command: attackCommand, cwd: workspace,
  signal: new AbortController().signal, writeRoots: [workspace, runTemp] }));
assert.equal(readFileSync(sentinel, 'utf8'), 'unchanged');
```

每个 attackCommand 由测试构造并正确 shell 引号转义临时路径，禁止针对真实用户文件。另测可用的本地 Node 测试命令正常通过。
- [ ] 运行 `node --import tsx --test tests/sandbox-boundaries.test.ts` 得到失败基线；在 macOS 核验实际系统沙箱能力及 Node/测试依赖读写需求，记录探针结果。无可用机制时保持阻断本任务完成，不能用 cwd 或正则替代承诺。
- [ ] 将两种工具包装共用授权执行函数；顺序为角色/硬禁令 → Pre Hook 最终输入 → policy/authorize → signal 再检查 → 执行。锁只控制执行，不改变权限。未接入审批 broker 时 ask 必须拒绝，不默认批准。将 bash 从 execSync 切到可取消的 runShell；授权操作也经受限执行器，越界写目标需准确授予，提权不得绕过限制。
- [ ] 文件路径工具共用安全路径/打开策略，测试 ../、同名前缀目录、已有/新建路径符号链接、检查后替换链接；参数改写后重新授权。对子代理 unlocked 路径添加相同拒绝测试，未知 MCP/插件副作用进入 ask。Hooks 的非关键日志异常可记录，权限判断异常必须拒绝。
- [ ] 运行新测试、tool-integration、subagents、worker；写入具体平台支持限制，提交。此门槛未过不宣称 R09 完成。

## Task 4：审批状态、IPC、停止和未知结果

**Files:** 新增 `src/runtime/approvals.ts`、`tests/approvals.test.ts`；修改 `service.ts`、`events.ts`、`worker.ts`、`worker-client.ts`、`src/web/server.ts`、`src/main.ts`、`src/agent/loop.ts`。

**Interfaces:** approvals.ts 定义 `Approval {id:string; runId:string; toolCallId:string; childRunId?:string; summary:string; inputHash:string; status:'pending'|'approved'|'denied'|'expired'}`。Execution/ExecutionOptions 增加可选 `authorize` 回调；Web 模式必须提供，CLI 保持已有策略。Runtime 增加 `decideApproval(id, decision:'approve'|'deny'): Approval`。IPC 为 `approval-request {requestId,operation}` 与 `approval-result {requestId,decision,error?}`。

- [ ] 写真实 executor 等待授权测试，未经批准执行计数为 0，允许一次后为 1；重复批准不重复执行，反向决策 409。独立测试拒绝、停止、父任务取消、过期、审批期间刷新和两个待确认请求。

```ts
assert.equal(effectCount, 0);
runtime.decideApproval(approval.id, 'approve');
runtime.decideApproval(approval.id, 'approve');
await runtime.idle();
assert.equal(effectCount, 1);
assert.throws(() => runtime.decideApproval(approval.id, 'deny'), /已处理/);
```

- [ ] 运行 `node --import tsx --test tests/approvals.test.ts` 确认失败；实现内存等待器和持久化脱敏记录，绑定 run/toolCallId/inputHash；生产批准接口不接受新参数。持久化 pending 后才发事件，持久化批准后才唤醒，唤醒后检查 signal；对多 pending 使用计数恢复 running。
- [ ] Worker pending map 增加 approval-result；abort/disconnect/exit 一并拒绝等待器。子代理沿用授权回调。API 加同源校验，Session 快照含审批摘要。恢复过期所有 pending；approved 但未完成执行的操作不得重放。
- [ ] 从 tool-start 与 tool-result/tool-error 按 toolCallId 归并生成 tool-unknown；给下次执行添加检查现场提示。检查 agentLoop 的重试分支：已调用有副作用工具或无法确认时禁止整步重试。给本地模型夹具注入“写一次后模型断流”，断言写入计数仍 1。
- [ ] 运行 approvals、worker、tool-integration、storage、runtime；验证 stop vs approve 竞争及消息脱敏，提交。

## Task 5：受约束文件 API 与变更记录

**Files:** 新增 `src/web/files.ts`、`tests/files.test.ts`；修改 `src/web/server.ts`、`src/tools/index.ts`、`src/runtime/events.ts`。

**Interfaces:** `listFiles(root,relativePath,offset,limit): Promise<{entries: FileEntry[];total:number}>`；`readPreview(root,relativePath): Promise<{path:string;absolutePath:string;kind:'text'|'binary';size:number;text?:string}>`；`openDownload(root,relativePath)` 返回安全打开的普通文件句柄、文件名和大小。FileEntry 为 `{name:string;path:string;kind:'file'|'directory';size?:number}`，统一从 files.ts 导出。

- [ ] app.request 测试目录和内容，以及拒绝外部文件：

```ts
const url = `/api/v1/workspaces/${workspace.id}/file?path=${encodeURIComponent('../sentinel.txt')}`;
assert.equal((await app.request(url)).status, 403);
assert.equal((await app.request(`/api/v1/workspaces/${workspace.id}/file?path=report.md`)).status, 200);
```

- [ ] 运行 `node --import tsx --test tests/files.test.ts`，确认路由不存在；实现 Spec 限制：单层分页默认 100 最大 200、预览 1 MiB、特殊文件拒绝、二进制不解码、符号链接越界拒绝、附件下载流/attachment/nosniff。操作同一个已校验句柄，避免校验后重新打开不受控路径。
- [ ] 文件工具成功后 emit `{type:'file-changed',toolCallId,path,action:'created'|'modified'}`，失败不产生成功事件；保留子代理关联。路径不能通过事件诱导 UI 无约束读取，始终经 workspace API。
- [ ] 测试二进制、超限、失效目录、特殊文件、下载 HTML/SVG 的 attachment、安全文件名、客户端取消下载后关闭句柄、文件变更失败场景；运行 files/web-boundaries/tool-integration 后提交。

## Task 6：React 迁移与第一版交互

**Files:** 新增前述 `web/src/` 组件、API/events 模块、`web/vite.config.ts`、`web/tsconfig.json`；修改 `package.json`、`pnpm-lock.yaml`、`web/index.html`、`src/web/server.ts`、`.gitignore`；保留并迁移 `web/style.css`；对等验证后删除旧 `web/app.js`。

**Interfaces:** `api<T>(path:string, init?:RequestInit): Promise<T>`、`mergeEvents(previous:Map<string,ExecutionEvent>, incoming:ExecutionEvent[]): Map<string,ExecutionEvent>`；组件由 App 持有 sessionId/workspaceId 和服务快照，子组件通过回调更新。前端类型通过明确 API DTO 共享，不将 Node runtime 导入浏览器。

- [ ] 先为事件去重和新标签页/刷新恢复添加 `tests/web-state.test.ts`：

```ts
const once = mergeEvents(new Map(), [event]);
const replay = mergeEvents(once, [event]);
assert.equal(replay.size, 1);
assert.equal([...replay.values()][0].id, event.id);
```

- [ ] 运行新测试确认缺失模块失败；添加 React/react-dom、Vite、TypeScript JSX 类型及 Markdown 解析/净化依赖，精确版本由安装写入锁文件，不使用运行时 CDN。脚本分开 `build:server`、`build:web`、`typecheck:web`，总 build 顺序执行三者；服务仅托管 web/dist。
- [ ] Vite root=web、build.outDir=dist、开发 `/api` proxy 指向本地 Hono；用组件迁移已有 route/草稿/SSE/键盘/抽屉语义：

```tsx
<SessionList onSelect={setSessionId} />
<Conversation sessionId={sessionId} />
<ExecutionTimeline events={orderedEvents} />
<FilePanel workspaceId={workspaceId} />
```

组件 props 显式定义；App 将服务 global busy 和当前 Run 状态传给输入区。列表增加搜索/归档/改名；首页增加独立任务目录入口。时间线按 toolCallId 和 childRunId 归组，显示耗时和 unknown；审批卡显示准确操作、允许/拒绝，等待期间仍可停止。
- [ ] 文件面板按需读取；Markdown 禁用原始 HTML，过滤危险 URL，不自动请求远程图片。文本用 textContent/React 文本节点。浏览器用恶意 Markdown fixture 验证脚本不执行、外部图片无网络请求。复制路径在失败时显示可选择路径。
- [ ] 执行 `npm run build`、web-state、web-boundaries 和 files；浏览器验证新增/改名/搜索/归档/恢复、全局忙碌提示、刷新审批、拒绝/批准、停止、文件预览下载、390px 窄屏和键盘焦点。迁移对等后移除旧入口并提交。

## Task 7：命令启动、两条闭环与交付

**Files:** 新增 `src/web/open-browser.ts`、`tests/web-startup.test.ts`；修改 `src/index.ts`、`src/web/server.ts`、`package.json`、`docs/local-web-workbench.md`；新增 `docs/verification/2026-09-20-personal-web-v1.md`。

**Interfaces:** `openBrowser(url:string): Promise<void>` 按平台 spawn 系统 opener、参数数组传 URL、不经 shell；startWeb 接受 `{open?:boolean}`，CLI 解析 `--no-open`，测试默认显式关闭打开行为。

- [ ] 通过注入 opener spy 测试：监听成功后只打开一次，启动失败不打开，no-open 不打开，opener 失败不关闭服务。运行 `node --import tsx --test tests/web-startup.test.ts` 得失败基线。
- [ ] 实现启动/构建静态资源错误提示与上面行为。使用 port 0 的真实服务，验证打印的是最终端口，入口 HTML 和资源都返回成功。
- [ ] 在临时目录执行文档闭环：读取 md/txt → 文件工具写报告 → 浏览器 Markdown 预览/下载；过程中刷新，执行计数仍 1。
- [ ] 执行编码闭环：文件修改 → 受限测试命令 → 记录退出码；注入慢测试停止，已写内容保留；强杀服务重启，任务中断且未知操作先核实。使用当前已有的本地 OpenAI SSE 测试夹具，不发送外部消息。
- [ ] 运行 `npm run build`、`npm test`、`git diff --check`，在新验收记录中逐条记录真实结果与限制，不覆盖旧验收；浏览器验证 1280px/390px、断线、等待确认、失败、减少动态效果。
- [ ] 更新使用说明：个人模式单任务无队列、审批和平台限制、托管目录、会话归档、文件预览上限、开发/构建启动、CLI 独立进程限制。检查文档与新行为一致后提交本任务范围。

## 需求覆盖与收口

| Spec | Task |
| --- | --- |
| R01 / R12 | 6、7；保留 CLI 与配置契约回归 |
| R02 / R10 | 3、5、6、7 |
| R03 / R04 | 2、6 |
| R05 | 1、4、6 |
| R06 / R14 | 4、5、6、7 |
| R07 / R08 / R13 | 1、3、4、7 |
| R09 | 3、4、5、7，真实边界探针为必要门槛 |
| R11 | 2、4、7；验证新会话历史为空且共享文件更新可见 |

本轮只交付设计和计划，未执行这些 checkbox。技术难点集中在 Task 3，必须在 UI 扩展前验证真实限制；其他差异已定位到已有 API/Runtime，不重复建设取消/恢复体系。执行采用主代理逐任务实施，子代理只辅助探索和核验。
