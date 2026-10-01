/**
 * Cheese Agent 命令行总入口 (CLI Entry Point)
 *
 * 【架构职责】：
 * 1. CLI 启动路由分发器（Command Router / Dispatcher）：
 *    - 作为 package.json 中 "bin" 与 "scripts" 的直达执行文件。
 *    - 负责解析顶层命令行参数（process.argv），按指令分发至子系统：
 *      - `init`: 启动交互式配置向导（Wizard），引导用户生成 cheese-agent.config.json 与 .env。
 *      - 其他或无参（默认）：启动主 Agent 系统交互式命令行界面（REPL & Multi-Channel Daemon）。
 * 2. 动态模块懒加载（Dynamic Lazy Import）：
 *    - 采用 ESM 的 `import()` 语法按需加载对应模块，避免在执行简单配置初始化命令时预先加载
 *      SQLite 向量库、大模型 SDK、飞书服务端等重量级模块，极大提升 CLI 响应速度。
 */

// 获取命令行传入的第一个位置参数 (如: pnpm start, tsx src/index.ts init)
const command = process.argv[2];

if (command === 'web') {
  import('./web/server.js').then(m => m.startWeb()).catch(error => { console.error(error); process.exitCode = 1; });
} else if (command === 'init') {
  // ── 分支 1：初始化向导 ─────────────────────────────────
  // 动态引入配置生成交互模块，执行终端向导流程
  import('./config/init.js').then(m => m.runInit());
} else {
  // ── 分支 2：启动主 Agent 运行时 ─────────────────────────
  // 动态导入主启动模块，执行全局 IoC 依赖装配、各子系统连接并进入交互循环
  import('./main.js').then(m => m.startAgent().catch(console.error));
}
