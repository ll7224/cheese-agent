# cmdk 末项键盘导航：准备和验收

任务材料是 [TASK.md](TASK.md)。给 Cheese 的工作副本保留缺陷，只加入本目录的 `fixture.patch`；参考补丁和固定裁判放在工作副本之外。

## 样本身份

- 项目：[dip/cmdk](https://github.com/dip/cmdk)，React + TypeScript 命令菜单组件。
- 起始提交：`9fae175d9bc993d0f72275388429ac0825a72108`，包内版本 `0.1.19`。
- 来源：[上游 PR #47](https://github.com/dip/cmdk/pull/47)，2022-09-05 合并，属于历史真实缺陷。
- `fixture.patch` 来自该 PR 的测试页面改动：只增加首部、分组内部、末尾三个禁用项，不修改库实现。
- `reference.patch` 采用 PR 最终的一行库修复。不要直接应用早期 `ce619bb` 提交，它还包含最终 PR 没有保留的 `id={id}` 改动。
- 固定裁判复制起始提交的 `test/keybind.test.ts`：9 项断言原样保留，仅改为 CommonJS 加载目标工作区的 Playwright。
- 上游代码、测试与补丁遵守 [MIT 许可证](LICENSE.md)。PR 贡献者为 `thiskevinwang`，上游版权信息保留。

## 可用环境

本机验证使用 macOS 26.5、Node 16.20.2、pnpm 7.9.0、Playwright 1.24.1、Chrome 155.0.8059.82。测试站为 Next 12.1.6 / React 18.2.0，依赖不升级。

Node 24 执行 pnpm 7.9.0 时出现 `ERR_INVALID_THIS`；使用临时 Node 16，而不是改锁文件。历史 WebKit 16.0 在当前主机 `newPage` 阶段关闭；裁判明确使用已安装的 Chrome，不把该环境失败算缺陷复现。Node 16 和 Next 12 仅用于本机历史样本，不用于生产部署。

## 从固定源码准备一个新副本

下面命令需允许网络下载，Chrome 应已安装。`mktemp` 创建全新目录，不覆盖旧运行。`CHEESE_REPO` 指向此仓库的绝对路径。

```sh
export CHEESE_REPO=/Users/Apple/code/cheese-agent
export CASE_ROOT=$(mktemp -d /private/tmp/cheese-cmdk.XXXXXX)
mkdir "$CASE_ROOT/workspace"
curl --fail --location \
  https://codeload.github.com/dip/cmdk/tar.gz/9fae175d9bc993d0f72275388429ac0825a72108 \
  -o "$CASE_ROOT/source.tar.gz"
tar -xzf "$CASE_ROOT/source.tar.gz" --strip-components=1 -C "$CASE_ROOT/workspace"
cd "$CASE_ROOT/workspace"
patch -p1 -i "$CHEESE_REPO/eval/cases/cmdk-disabled-last/fixture.patch"
npm exec --yes --package=node@16.20.2 --package=pnpm@7.9.0 -- \
  pnpm install --frozen-lockfile --ignore-scripts \
    --filter cmdk-root --filter cmdk --filter cmdk-tests \
    --store-dir "$CASE_ROOT/pnpm-store"
npm exec --yes --package=node@16.20.2 --package=pnpm@7.9.0 -- pnpm run build
```

解包来源是固定提交而非最新分支，没有 Git 历史或修复提交。库源码保持原版，依赖安装跳过生命周期脚本；已验证的构建使用包内 `pnpm run build`，不要在根目录直接调用 tsup 构建子包。

## 运行固定裁判

从目标 cmdk 根目录运行，输出目录位于工作区外：

```sh
NEXT_TELEMETRY_DISABLED=1 CHEESE_CASE_OUTPUT="$CASE_ROOT/evidence/baseline" \
  npm exec --yes --package=node@16.20.2 --package=pnpm@7.9.0 -- \
  pnpm exec playwright test \
    --config="$CHEESE_REPO/eval/judge/cmdk-disabled-last/playwright.config.cjs"
```

**原版预期：** 6 项通过、3 项失败；失败断言期待 `last`，实际仍为 `first`。失败项是 Meta+ArrowDown、Meta+Control+j、Meta+Control+n 对应的三个测试。

参考修复仅用于校准裁判，在另一份相同副本上应用：

```sh
mkdir "$CASE_ROOT/reference-workspace"
tar -xzf "$CASE_ROOT/source.tar.gz" --strip-components=1 -C "$CASE_ROOT/reference-workspace"
cd "$CASE_ROOT/reference-workspace"
patch -p1 -i "$CHEESE_REPO/eval/cases/cmdk-disabled-last/fixture.patch"
npm exec --yes --package=node@16.20.2 --package=pnpm@7.9.0 -- \
  pnpm install --frozen-lockfile --ignore-scripts \
    --filter cmdk-root --filter cmdk --filter cmdk-tests \
    --store-dir "$CASE_ROOT/pnpm-store"
patch -p1 -i "$CHEESE_REPO/eval/judge/cmdk-disabled-last/reference.patch"
npm exec --yes --package=node@16.20.2 --package=pnpm@7.9.0 -- pnpm run build
NEXT_TELEMETRY_DISABLED=1 CHEESE_CASE_OUTPUT="$CASE_ROOT/evidence/reference" \
  npm exec --yes --package=node@16.20.2 --package=pnpm@7.9.0 -- \
  pnpm exec playwright test \
    --config="$CHEESE_REPO/eval/judge/cmdk-disabled-last/playwright.config.cjs"
```

**参考修复预期：** 9 项全部通过。启动使用 `127.0.0.1:43817`，端口占用时明确失败，不复用已有服务。测试结束由 Playwright 关闭它启动的服务。旧 Browserslist 数据警告不影响断言，不为此更新历史锁文件。

## 交给 Cheese 与独立验收

交给 Agent 前，将 solution-free 的 Chrome 入口复制到样例目录外层：

```sh
cp "$CHEESE_REPO/eval/cases/cmdk-disabled-last/playwright.chrome.config.cjs" \
  "$CASE_ROOT/playwright.chrome.config.cjs"
```

该入口使用候选工作区原有 `test/keybind.test.ts`，不引用固定裁判或参考补丁。新目录应相应替换 `TASK.md` 中的工作区、配置和输出路径。可在候选目录的 `cheese-agent.config.json` 加入 `"execution": { "tokenBudget": 2000000 }`；参数在创建新会话时保存，旧会话不会自动增加预算。

1. 只给 Cheese **保留缺陷的副本**和 `TASK.md`。cmdk 构建/测试子命令使用 Node 16 / pnpm 7.9；Cheese 本身继续使用原有 Node 环境，不全局降级。不要给它本 README、PR 链接、参考补丁或旧结果。
2. 本案例属于开发样例，后续不能计入未见任务集。它用于确认运行闭环，知识检索和子代理都不强制调用。
3. 最终判分从干净起始版本加 fixture 建立裁判副本，只移入候选对 `cmdk/src/` 的修改；裁判、fixture、依赖和配置保持固定。
4. 执行构建与固定 9 项测试。候选不得通过移除禁用项、修改断言、硬编码条目名称或绕过功能来获得通过；同时检查代码差异符合最小修复要求。
5. 参考答案与运行材料只存于主持人的仓库/证据目录，不进入知识索引。目录分开不是 OS 权限沙箱；需要强隔离评估时另行使用受控环境。

本机工作副本：`/private/tmp/cheese-m0-cmdk/agent-workspace`，现已包含首次 Cheese 尝试产生的一行有效修复，不能再当作未修复副本。完整采集记录位于 `/private/tmp/cheese-m0-cmdk/evidence`；新尝试或临时目录清理后按以上步骤重建。实际运行与后续辅助验收见[案例记录](../../../docs/showcase/CASE_STUDY.md)。

本机临时 Node/pnpm 工具目录为 `/Users/Apple/.npm/_npx/bbae2065cbe05db8/node_modules/.bin`。只在 cmdk 构建/测试子命令前设置 `PATH` 指向它即可使用已安装版本；不要修改 Cheese 服务的进程环境。

本次上游测试对照为 6/9 → 9/9。外置裁判为原版 6/9；参考版首次 8/9，另 1 项页面加载超时，单独重跑通过。保留首次失败和补跑记录，见[证据摘要](../../evidence/cmdk-disabled-last/summary.json)。
