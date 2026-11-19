# cmdk 第二题：搜索与动态卸载后的分组排序

这是原版源码中已有的分组排序缺陷；本次构造了确定性页面和4项断言来复现，没有向库实现注入故障。固定版本、Node/Chrome 和依赖复用第一题。此题是第二个开发样例，不计入未见评估集。

## 样本与当前状态

- 上游：dip/cmdk，提交 `9fae175d9bc993d0f72275388429ac0825a72108`，版本0.1.19，MIT。
- 原文依据：`ARCHITECTURE.md` 以DOM顺序为选中顺序；README 的 Asynchronous results 说明动态结果自动过滤与排序；源码定义组按最高项目分数排序。
- `fixture.patch` 仅增加 `test/pages/dynamic-groups.tsx` 和 `test/dynamic-groups.test.ts`，不改原版文件。
- 本地候选目录：`/private/tmp/cheese-m1-dynamic-groups/workspace`，现已包含Cheese实际运行的修复。未修复起点应按下节用固定归档重建，不重置或覆盖本次候选。
- 中立执行配置：本目录 `playwright.chrome.config.cjs`，本机副本位于 `/private/tmp/cheese-m1-dynamic-groups/playwright.chrome.config.cjs`。
- 给Agent的输入仅为 `TASK.md` 和候选目录；不要给本README、清单、固定裁判、参考补丁或运行证据。

## 准备新副本

已准备副本无需重装。重建时用第一题保留的固定归档和离线依赖缓存：

```sh
export CHEESE_REPO=/Users/Apple/code/cheese-agent
export CASE_ROOT=$(mktemp -d /private/tmp/cheese-group-ranking.XXXXXX)
mkdir "$CASE_ROOT/workspace"
tar -xzf /private/tmp/cheese-m0-cmdk/upstream.tar.gz \
  --strip-components=1 -C "$CASE_ROOT/workspace"
cp "$CHEESE_REPO/eval/cases/cmdk-group-ranking/playwright.chrome.config.cjs" \
  "$CASE_ROOT/playwright.chrome.config.cjs"
cd "$CASE_ROOT/workspace"
patch -p1 -i "$CHEESE_REPO/eval/cases/cmdk-group-ranking/fixture.patch"
export NODE_OPTIONS=""
export PATH="/Users/Apple/.npm/_npx/bbae2065cbe05db8/node_modules/.bin:$PATH"
pnpm install --offline --frozen-lockfile --ignore-scripts \
  --filter cmdk-root --filter cmdk --filter cmdk-tests \
  --store-dir /private/tmp/cheese-m0-cmdk/pnpm-store
pnpm run build
```

缓存或归档缺失时，按第一题的[准备文档](../cmdk-disabled-last/README.md)获取同一固定版本，不升级依赖。不要直接复制旧 `node_modules`：pnpm 7 的 `.bin` 启动脚本含绝对 `NODE_PATH`，会混用另一副本的React。离线安装能在新目录生成正确链接。

为新目录合并 `execution.tokenBudget: 2000000`，关闭该目录的Cron、飞书及非必要插件；按实际路径替换 TASK 的工作区、配置及输出路径。不要全局降级Cheese自身的Node环境。`rag.enabled=false` 不代表所有知识路径关闭；此阶段不做知识开关效果对照。

## 固定验收

从候选根目录运行：

```sh
pnpm run build &&
NEXT_TELEMETRY_DISABLED=1 CHEESE_CASE_OUTPUT="$CASE_ROOT/evidence/judge" \
pnpm exec playwright test \
  --config="$CHEESE_REPO/eval/judge/cmdk-group-ranking/playwright.config.cjs"
```

共15项：4项新排序断言、9项原有键盘断言、2项原有分组断言。固定裁判的断言与候选侧测试一致，但位于候选目录外，防止改断言获取通过。Chrome端口43818，端口占用明确失败，不复用其他服务。

2026-10-17 校准结果：

| 候选 | 构建 | 固定验收 |
| --- | --- | --- |
| 原版源码 + 新页面 | 通过 | 12通过、3失败；基线主批13项10通过/3失败，新增分组回归2项单独通过 |
| 单独参考副本 | 通过 | 15/15一次通过 |

原版失败覆盖静态搜索改变后的组排序、先删除再搜索、搜索中删除。参考修复只在外部副本中；先前仅清理卸载项仍失败，由此确认还需修正分组查找标识与触发重排。证据见 `eval/evidence/cmdk-group-ranking/summary.json`。不能把主持人的参考校准当作Cheese已经解题。

## 这一轮完成条件

用户在该目录的新会话提交TASK后，不再人工提示原因。Cheese完成最小源码补丁、构建、15项测试并返回交付摘要；主持人检查实际diff并用固定裁判验收。记录运行终态、用量、耗时和人工介入。只修代码但不交付仍未完成；遇到环境错误也保留实际失败。

Cheese的 `bash` 工具支持 `timeoutMs`；本题构建/测试用120000毫秒。命令默认10秒只适合短检查，不能承载约25秒的红灯测试。

## 实际候选验收结果

2026-10-17，Cheese一轮完成任务并返回交付：26步、25次工具调用、约9分4秒、累计1,166,425 Token。中途一次构建失败后自行修正。主代理在干净副本中只移入候选库源码，独立构建和冻结15项全部通过。

补充的同名分组诊断用例失败：公开heading/value不唯一时，候选仍以该值定位DOM。此诊断位于 `eval/probes/cmdk-group-ranking/`，与冻结验收分开，参考副本通过同一诊断。后续改进只需围绕该边界，不应把本轮“固定15项通过”扩大为所有边界已覆盖。证据与补丁见[候选记录](../../evidence/cmdk-group-ranking/candidate-result.json)。

## 同名分组后续修正：已通过并冻结

用户已在新会话完成FOLLOWUP；2026-10-17主代理在干净副本构建和外置16项全部通过。候选仍保留最终修复，不应再当未修复起点提交任务。以下是准备过程，需重建历史现场时使用。最终结果见[followup-result.json](../../evidence/cmdk-group-ranking/followup-result.json)；第一轮冻结15项及后续失败记录均不覆盖。

给Cheese的任务为 [FOLLOWUP.md](./FOLLOWUP.md)。在保留当前候选补丁的前提下，向工作副本添加已有诊断页和断言，并复制中立执行配置；不改库源码，也不覆盖第一轮的TASK或证据。

```sh
export CHEESE_REPO=/Users/Apple/code/cheese-agent
export CASE_ROOT=/private/tmp/cheese-m1-dynamic-groups
cp "$CHEESE_REPO/eval/probes/cmdk-group-ranking/duplicate-groups.tsx" \
  "$CASE_ROOT/workspace/test/pages/duplicate-groups.tsx"
cp "$CHEESE_REPO/eval/probes/cmdk-group-ranking/duplicate-groups.test.js" \
  "$CASE_ROOT/workspace/test/duplicate-groups.test.js"
cp "$CHEESE_REPO/eval/cases/cmdk-group-ranking/playwright.followup.config.cjs" \
  "$CASE_ROOT/playwright.followup.config.cjs"
cp "$CHEESE_REPO/eval/cases/cmdk-group-ranking/FOLLOWUP.md" \
  "$CASE_ROOT/workspace/FOLLOWUP.md"
```

同一目录新建会话，只发送“请读取当前工作目录的 FOLLOWUP.md，按要求修复、验证并交付。”沿用该目录已有的2,000,000累计Token配置，不把上一轮26步历史带进来。该配置运行原15项及新增1项；第一轮固定裁判与验收记录保持不变。

独立验收从原归档建立干净副本，只移入新的库源码及固定页面/测试fixture，原冻结15项和外置同名分组断言共同通过。记录为同一开发样例的人工反馈后修正，不并入第一轮自主完成记录，也不计作新未见任务。下一步进入录屏与求职说明。
