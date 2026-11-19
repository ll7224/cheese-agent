# 修复搜索菜单的分组排序

工作目录：`/private/tmp/cheese-m1-dynamic-groups/workspace`。

cmdk 使用 React + TypeScript 实现可组合命令菜单。测试站 `/dynamic-groups` 有 Projects 和 Actions 两个组，支持搜索和动态添加/删除一个临时项目。

## 问题和预期

分组应按各组当前最高匹配分数降序排列，但现在改变搜索或删除临时项目后，组顺序仍可能停留在原位置。

测试页面使用固定分数，排除模糊匹配算法差异：

- 搜索 `rank`：临时项目为 1，Project 为 0.2，Action 为 0.8，应为 Projects → Actions。
- 搜索 `actions-first`：临时项目变为 0.1，其余不变，应为 Actions → Projects。
- 删除临时项目后搜索 `rank`，或在搜索中删除它：应为 Actions → Projects。
- 删除选中项目后应选择排序后的第一个可用项；重新加入临时项目后应恢复正确排序。

请复现、定位原因，并在库实现 `cmdk/src/` 内完成最小修复。保持现有公开 API、分组值、过滤和键盘行为。

## 执行环境与命令

依赖已安装。该副本来自固定源码归档，没有 Git 历史，不必运行 `git diff`。不要升级 Node、依赖或锁文件。只在下面子命令中设置环境，不要改 Cheese 服务。调用 `bash` 执行构建/测试时传 `timeoutMs: 120000`；默认10秒不足以完成这组测试。

```sh
cd /private/tmp/cheese-m1-dynamic-groups/workspace
export NODE_OPTIONS=""
export PATH="/Users/Apple/.npm/_npx/bbae2065cbe05db8/node_modules/.bin:$PATH"
pnpm run build &&
NEXT_TELEMETRY_DISABLED=1 \
CHEESE_CASE_OUTPUT=/private/tmp/cheese-m1-dynamic-groups/evidence/agent \
pnpm exec playwright test \
  --config=/private/tmp/cheese-m1-dynamic-groups/playwright.chrome.config.cjs
```

该命令运行 4 项排序断言、原有 9 项键盘断言及 2 项分组断言，共 15 项。使用 Chrome 和独立端口 `43818`，不使用 WebKit 或 `localhost:3000`，不复用其他服务。

## 工作边界与交付

- 仅修改 `cmdk/src/`。不要更改测试断言、测试页面、配置、依赖或公开 API，不硬编码测试项目名称/分数。
- 使用工作副本内源码、文档与测试，不查询远端修复、其他工作副本、主持人的裁判、参考补丁或证据目录内容。
- 不派发子 Agent。先复现，再修复；最后执行一次指定构建和测试。通过后立即交付，不扩展到无关测试；失败时只针对失败项调查。
- 最终答复列出原因、修改文件、实际构建结果、测试通过/失败数和未完成事项。遇到环境阻塞时保留现场，说明错误，不终止其他应用抢端口。

本目录的新会话配置为 2,000,000 累计 Token。请在工作台为该目录新建会话，不继续上一题的长历史。
