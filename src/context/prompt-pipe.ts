import type { MemoryStore } from '../memory/store.js';
import type { SqliteVectorStore } from '../rag/sqlite-store.js';
import type { PromptContext } from './prompt-builder.js';

export function memoryContext(memoryStore: MemoryStore): (ctx: PromptContext) => string | null {
  return () => memoryStore.buildPromptSection();
}

export function ragContext(vectorStoreOrGetter?: SqliteVectorStore | (() => SqliteVectorStore | null) | null): (ctx: PromptContext) => string | null {
  return () => {
    if (!vectorStoreOrGetter) return null;
    const store = typeof vectorStoreOrGetter === 'function' ? vectorStoreOrGetter() : vectorStoreOrGetter;
    if (!store) return null;
    const size = store.size();
    if (size === 0) return null;
    const sources = store.sources();
    return `[知识库] 已导入 ${size} 个文档片段（来源: ${sources.join(', ')}）。使用 rag_search 工具搜索知识库。`;
  };
}

export function engineeringKnowledgeRules(): (ctx: PromptContext) => string {
  return () => `
[工程知识证据引用、避坑备忘与防越权规则]
1. 模块触碰防御性契约 (JIT Guardrail Memo):
   - 当读取或编辑代码时，若工具输出中包含 \`[PROJECT MEMO: <scope>]\`，其中列出的 \`⚠️ 核心约束\` 具备最高工程权威，必须严格遵守；\`💡 历史避坑\` 是此前排查出的已知踩坑陷阱，禁止复犯。
2. 关键避坑与规则沉淀 (Record Guardrails):
   - 当用户要求“记下这个经验/规范”或你在解决疑难问题且包含重要防坑细节时，可以使用 \`record_guardrail\` 工具将核心规约与原因沉淀入库。
3. 知识中心记录类别：
   - [code]: 源码结构、函数、类与符号定义片段
   - [document]: 规范说明、架构文档与受管资料
   - [rule]/[decision]: 经明确确认的架构决议或团队规约（最高权威）
   - [experience]/[observation]: 历史避坑实践与命令执行结果验证
4. 任何工程结论必须关联引用证据，缺少依据时应明确说明未知，不得无凭据断言。
5. 发现文档说明与代码实现存在差异时，应如实陈述冲突并给出两方引用，严禁单方面建立“识别冲突即自动纠正源码”的流程。
`.trim();
}
