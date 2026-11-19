# 修复命令菜单的末项键盘导航

项目使用 React + TypeScript 实现可组合的命令菜单。测试站的 `/keybinds` 页面包含普通项目、分组和若干禁用项。

## 问题

输入框获得焦点后，按 `⌘+↓` 应当选中最后一个可用项目 `Last`，但当前仍停留在 `First`。列表开头、分组内部和末尾都可能存在禁用项。

请定位原因并提交最小范围修复，保持现有公开 API 和组件组合方式。

## 验收

- `⌘+↓` 可以跳到最后一个可用项，`⌘+↑` 可以回到第一个可用项。
- 等价的 `Meta+Control+j/n` 与 `Meta+Control+k/p` 快捷键行为一致。
- 普通上下移动、Control+j/k、Control+n/p 和 Alt 分组跳转保持正常。
- 禁用项不能成为键盘选中项。
- 所有 9 项已有 `keybind.test.ts` 断言通过，构建通过。

## 工作边界

- 仅修改库实现 `cmdk/src/`；不要更改测试断言、测试页面、依赖、构建配置或公开 API。
- 已为任务准备含禁用项的测试页面，不需要重新造页面。
- 使用本地源码和项目文档调查；不要查询远端修复记录或打开工作区外的参考答案。
- 先说明复现结果，最后交付原因、修改位置和实际验证结果。无法验证时说明具体原因。

## 本机执行入口

已准备 Node 16.20.2、pnpm 7.9.0、React 18.2.0 和 Playwright 1.24.1。只在 cmdk 构建/测试子命令中设置下列 PATH，不要更改 Cheese 服务的 Node 环境。

```sh
cd /private/tmp/cheese-m0-cmdk/agent-workspace
export PATH="/Users/Apple/.npm/_npx/bbae2065cbe05db8/node_modules/.bin:$PATH"
pnpm run build
NEXT_TELEMETRY_DISABLED=1 \
CHEESE_CASE_OUTPUT=/private/tmp/cheese-m0-cmdk/evidence/agent-keybind \
pnpm exec playwright test \
  --config=/private/tmp/cheese-m0-cmdk/playwright.chrome.config.cjs
```

这个中立配置运行工作副本内原有的 9 项测试，使用已安装的 Chrome 和独立端口 `43817`，不复用其他服务。不使用默认 WebKit、不连接 `localhost:3000`、不猜测浏览器 CLI 参数。端口占用或启动失败时，报告具体错误，不终止其他应用来抢占端口。该配置不含修复答案，不要修改它或测试断言。

本样例的新会话已配置每个 Agent 循环 2,000,000 累计 Token 预算；主循环与每个子循环分别计量，不是总费用上限。建议先完成本地复现和源码定位，不派发非必要子任务。
