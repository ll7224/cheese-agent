# 修复同名分组的搜索排序

工作目录：`/private/tmp/cheese-m1-dynamic-groups/workspace`。

这个目录保留了上一轮分组排序修复。不要重新实现整题，也不要撤销现有修复。本轮只处理新增的一个边界，并保持原有15项测试通过。

## 复现与预期

打开测试页 `/duplicate-groups`。页面有两个标题都为 `Results` 的分组，最初低分组在前。搜索 `rank` 后，`Weak match` 的匹配分数为0.2，`Strong match` 为0.8。

预期：包含 `Strong match` 的分组应排到前面。当前实现仍保留低分组在前的顺序。两个分组应能独立排序，不能要求使用者把标题改成不同文字。

请先运行新增用例复现，再定位并在 `cmdk/src/` 内完成最小修复。保持现有公开API、分组值、过滤、动态卸载及键盘行为。不硬编码标题、项目名称或分数。

## 命令

依赖已经安装。调用 `bash` 执行以下命令时传 `timeoutMs: 120000`。环境变量只作用于cmdk子命令，不修改Cheese服务环境，不升级依赖或锁文件。

先只复现新增用例：

```sh
cd /private/tmp/cheese-m1-dynamic-groups/workspace
export NODE_OPTIONS=""
export PATH="/Users/Apple/.npm/_npx/bbae2065cbe05db8/node_modules/.bin:$PATH"
NEXT_TELEMETRY_DISABLED=1 \
CHEESE_CASE_OUTPUT=/private/tmp/cheese-m1-dynamic-groups/evidence/followup-red \
pnpm exec playwright test duplicate-groups.test.js \
  --config=/private/tmp/cheese-m1-dynamic-groups/playwright.followup.config.cjs
```

修复后，构建并运行原15项及新增1项，共16项：

```sh
cd /private/tmp/cheese-m1-dynamic-groups/workspace
export NODE_OPTIONS=""
export PATH="/Users/Apple/.npm/_npx/bbae2065cbe05db8/node_modules/.bin:$PATH"
pnpm run build &&
NEXT_TELEMETRY_DISABLED=1 \
CHEESE_CASE_OUTPUT=/private/tmp/cheese-m1-dynamic-groups/evidence/followup-final \
pnpm exec playwright test \
  --config=/private/tmp/cheese-m1-dynamic-groups/playwright.followup.config.cjs
```

使用Chrome和独立端口43818，不复用其他服务。若端口被占用，说明错误，不终止其他应用。

## 范围与交付

- 仅修改 `cmdk/src/`，不改测试、页面、配置、依赖或公开API。
- 只使用当前副本的源码、文档与测试；不查询远端修复、其他副本、主持人的裁判、参考补丁或证据目录。
- 不派发子Agent。源码归档没有Git历史，不必执行 `git diff`。
- 最后集中做一次指定构建和16项测试；通过后立即交付。失败只调查受影响项，不扩展到无关测试。
- 最终答复列出原因、修改文件、实际构建结果、测试通过/失败数和未完成事项。环境阻塞也必须在答复中说明，不能把运行结束当作修复成功。
