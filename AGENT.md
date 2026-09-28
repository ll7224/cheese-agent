# Antigravity Global Engineering Standards & Architecture Guidelines (全局工程与架构规范)

> **Scope**: Machine-wide Global Rules for Antigravity AI Agent  
> **Target**: All languages, frameworks, and projects (Rust, Python, TypeScript/JavaScript, C/C++, Go, etc.)

---

## 1. 单文件规模硬性红线 (File Size Ceiling & Anti-Bloat Policy)

为了防止代码库随着特性迭代发生架构恶性腐化（例如产生数千行的“上帝文件 / God Module”），导致语言服务（Rust-Analyzer / Pylance / TSServer / Clangd）索引迟滞、上下文窗口与 Git Diff 爆炸以及增量构建变慢，特设立以下代码规模红线：

1. **推荐规模区间**：
   - 单个源码文件（`.rs`, `.py`, `.ts`, `.cpp`, `.go` 等）的代码量原则上推荐控制在 **300 ~ 500 行** 以内。
2. **硬性红线门限 (Hard Ceiling)**：
   - **严禁单个源码文件超过 800 ~ 1,000 行**。
   - 一旦某个文件由于业务拓展逼近或超过 800 行，必须立刻启动模块化重构，严禁继续向该文件直接追加新功能。
3. **拒绝上帝模块 (No God Objects / Kitchen Sink)**：
   - 严禁将巨型单文件作为跨领域特性的“垃圾场”。当遇到既有的大文件时，主动进行领域驱动拆解，优先还清技术债务。

---

## 2. 单一职责原则与领域物理隔离 (Single Responsibility & Domain Physical Isolation)

1. **关注点物理隔离 (Separation of Concerns)**：
   - 异构职责的代码必须在文件系统层面上进行物理分包与分文件隔离：
     - **数据领域层 (Domain / Models / Entities)**：专注业务数据结构、领域实体与持久化映射。
     - **展示层 / UI (Presentation / View / Controllers)**：专注界面状态机、视图组件、交互渲染与生命周期。
     - **底层通信 / 网络 (Network / Protocol / Transport)**：专注请求解密、报文收发、序列化契约与中间件。
     - **核心算法 / 数学 (Math / Algorithms / Core Logic)**：专注空间几何、物理模拟、核心调度计算。
     - **外设与输入守卫 (Input / Guards / Hardware)**：专注外设事件分发、防误触、射线检测与拦截。
2. **架构分派与消除条件瀑布流 (Short-Circuit & Table-Driven Dispatching)**：
   - 严禁在单个函数中堆砌数十个 `if-else` 或巨大 `switch-case`（如数百上千行的条件瀑布流）。
   - 必须采用**短路链式分发器（Short-circuit Dispatcher）**、**表驱动映射（Table-driven Mapping）**或**责任链模式（Chain of Responsibility）**将分发逻辑下沉至各个具体的子领域模块。
3. **对称目录设计 (Symmetric Submodule Design)**：
   - 在系统由多个成对组件构成的场景下（如 Hook 钩子 与 Scanner 扫描器、Client 与 Server、Request 与 Response），子模块必须保持严格一对一的镜像目录与命名规范。

---

## 3. 门面模式与对外零破坏兼容 (Facade Pattern & Seamless Integration)

1. **高内聚低耦合与门面导出**：
   - 子模块拆解后，必须通过其父级包/模块的根入口文件（如 Rust `mod.rs`、Python `__init__.py`、TypeScript `index.ts`、C/C++ 聚合头文件）统一进行公开重新导出（`pub use ...` / `export *` / `__all__`）。
   - 外部调用方（测试代码、服务上层、跨模块引用）保持统一顶层命名空间访问，实现**调用点 100% 透明且零破坏**。
2. **防循环依赖**：
   - 子模块之间严禁形成循环依赖网。公共类型提取至专用 `types` / `helper` 基础模块。

---

## 4. 零成本抽象与编译期全绿保障 (Zero-Cost Abstraction & Verification)

1. **运行时零损耗保证**：
   - 模块化拆分是代码组织与可读性的编译期工程实践。重构必须确保零额外内存分配、零额外调用穿透开销（充分利用编译器的内联与 LTO 优化）。
2. **重构交付标准（全绿保障）**：
   - 任何重构完成后，必须第一时间执行对应语言的严格静态检查与构建验证（如 `cargo check`、`cargo build --release`、`tsc --noEmit`、`pytest`、`flake8`、`golangci-lint`），必须确保 **0 errors、0 warnings**，严禁遗留未解决的代码坏味道。


## 5. File Operation Rules

When fulfilling a delete request, prefer a verified Windows Recycle Bin operation instead of commands that delete permanently, such as `Remove-Item`, `del`,  `rm` or `rd`. Use permanent deletion only when the user explicitly asks to erase the files completely or says they never want to see any trace of them again.

Before large-scale file deletion or movement, preview the affected file list with a dry run or an explicit operation plan, then proceed after confirmation. Do not add this extra confirmation step for small, obvious operations involving only one or two files.