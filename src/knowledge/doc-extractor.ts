import type { KnowledgeItemKind, KnowledgeStatus } from './types.js';

export interface ExtractedDocItemDraft {
  kind: KnowledgeItemKind;
  status: KnowledgeStatus;
  text: string;
  evidenceChunkId: string;
  startLine: number;
  endLine: number;
  sourceSnippet: string;
  matchedEntityIds?: string[];
  matchedEntityNames?: string[];
}

export interface ChunkInfo {
  id: string;
  text: string;
  startLine: number;
  endLine: number;
}

export interface EntityInfo {
  id: string;
  name: string;
}

/**
 * 扫描文本中提及的现有代码 AST 实体，并返回匹配的实体信息
 */
export function linkDocEntities(
  text: string,
  entities: EntityInfo[]
): { matchedIds: string[]; matchedNames: string[] } {
  const matchedIds: string[] = [];
  const matchedNames: string[] = [];

  for (const ent of entities) {
    if (!ent.name || ent.name.length < 3) continue;

    // 匹配完整的标识符或中文包裹的代码符号
    const escaped = ent.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(?:^|[^a-zA-Z0-9_$])${escaped}(?:$|[^a-zA-Z0-9_$])`, 'i');
    if (regex.test(text)) {
      if (!matchedIds.includes(ent.id)) {
        matchedIds.push(ent.id);
        matchedNames.push(ent.name);
      }
    }
  }

  return { matchedIds, matchedNames };
}

/**
 * 根据行号查找包含该行的目标切片
 */
function findChunkForLine(chunks: ChunkInfo[], lineNum: number): ChunkInfo | undefined {
  return chunks.find((c) => c.startLine <= lineNum && c.endLine >= lineNum) || chunks[0];
}

/**
 * 确定性（零 LLM）从 Markdown 文档中提取结构化知识条目
 */
export function extractDeterministicFromDoc(
  doc: { id: string; sourceKey: string },
  content: string,
  chunks: ChunkInfo[],
  entities: EntityInfo[] = []
): ExtractedDocItemDraft[] {
  const lines = content.split('\n');
  const drafts: ExtractedDocItemDraft[] = [];
  const seenTexts = new Set<string>();

  let currentHeading = '';
  let inAdrSection = false;
  let sectionKind: KnowledgeItemKind | null = null;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    // 检测 Markdown 标题
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      currentHeading = headingMatch[2].trim();
      const hLower = currentHeading.toLowerCase();

      if (hLower.includes('decision') || hLower.includes('决策') || hLower.includes('adr')) {
        inAdrSection = true;
        sectionKind = 'decision';
      } else if (
        hLower.includes('constraint') ||
        hLower.includes('约束') ||
        hLower.includes('规范') ||
        hLower.includes('规则') ||
        hLower.includes('rule')
      ) {
        inAdrSection = true;
        sectionKind = 'observation';
      } else if (
        hLower.includes('practice') ||
        hLower.includes('实践') ||
        hLower.includes('建议') ||
        hLower.includes('经验') ||
        hLower.includes('experience')
      ) {
        inAdrSection = true;
        sectionKind = 'experience';
      } else {
        inAdrSection = false;
        sectionKind = null;
      }
      continue;
    }

    // 提取列表项、引用或段落文本
    let sentence = trimmed.replace(/^[-*+>]\s+/, '').replace(/^\d+\.\s+/, '').trim();
    if (sentence.length < 5) continue;

    let candidateKind: KnowledgeItemKind | null = null;
    let candidateStatus: KnowledgeStatus = 'candidate';

    // 1. 若处于特定标题板块中
    if (inAdrSection && sectionKind) {
      candidateKind = sectionKind;
      // 若处于明确的 ADR 决策章节，标记为候选或建议
      candidateStatus = 'candidate';
    } else {
      // 2. 正则语义强断言检测
      if (
        /(?:必须|严禁|统一使用|选用|定为|强制|禁止|不得|确定采用|全面升级为)/.test(sentence) &&
        !/(?:或许|可能|讨论中|待定)/.test(sentence)
      ) {
        candidateKind = 'decision';
      } else if (/(?:规范|约束|上限|限额|超时时限|单次最大|端口|版本要求|基线)/.test(sentence)) {
        candidateKind = 'observation';
      } else if (/(?:建议|推荐|最佳实践|优先|可以考虑|经验总结)/.test(sentence)) {
        candidateKind = 'experience';
      }
    }

    if (!candidateKind) continue;

    // 清理 markdown 加粗、行内代码与超链接格式
    const cleanText = sentence
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .trim();

    if (cleanText.length < 6 || seenTexts.has(cleanText)) continue;
    seenTexts.add(cleanText);

    const chunk = findChunkForLine(chunks, lineNum);
    if (!chunk) continue;

    const { matchedIds, matchedNames } = linkDocEntities(cleanText, entities);

    drafts.push({
      kind: candidateKind,
      status: candidateStatus,
      text: cleanText,
      evidenceChunkId: chunk.id,
      startLine: lineNum,
      endLine: lineNum,
      sourceSnippet: trimmed,
      matchedEntityIds: matchedIds,
      matchedEntityNames: matchedNames,
    });
  }

  return drafts;
}

/**
 * 结合 LLM 生成的高质量模型提取
 */
export async function extractWithModelFromDoc(
  doc: { id: string; sourceKey: string },
  content: string,
  chunks: ChunkInfo[],
  entities: EntityInfo[],
  model: any,
  signal?: AbortSignal
): Promise<ExtractedDocItemDraft[]> {
  try {
    const { generateText } = await import('ai');

    const prompt = `你是一个资深软件工程知识库架构师。请仔细阅读以下工程技术文档，提炼出其中的核心架构决议、设计约束和实践经验。

【输入文档标识】: ${doc.sourceKey}
【文档内容】:
${content.slice(0, 15000)}

【提取规则】
1. kind 仅限以下三种枚举：
   - "decision": 明确的技术选型、架构决议、不可违背的硬性方案
   - "observation": 运行环境约束、规范限制、参数基线
   - "experience": 经验建议、排障总结、最佳实践
2. 保持原子化陈述：每一条必须是一句独立、明确、可执行或可验证的技术结论，绝不得带有“本文介绍了...”、“根据文档说明...”等冗余叙述。
3. 严格基于文档原文事实，严禁主观推论或臆测。
4. 每条必须提供从原文摘录的关键句 (sourceSentence)，以便精确定位行号。
5. 最多提取 15 条最具代表性的核心知识。

【输出格式】
严格输出纯 JSON 数组，严禁包含任何 Markdown 标记或额外解释：
[
  {
    "kind": "decision" | "observation" | "experience",
    "text": "提炼出的独立结论",
    "sourceSentence": "原文中对应的关键原句"
  }
]`;

    const res = await generateText({
      model,
      prompt,
      abortSignal: signal,
    });

    const jsonText = res.text.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '');
    const rawItems = JSON.parse(jsonText);

    if (!Array.isArray(rawItems)) {
      return extractDeterministicFromDoc(doc, content, chunks, entities);
    }

    const lines = content.split('\n');
    const drafts: ExtractedDocItemDraft[] = [];
    const seen = new Set<string>();

    for (const raw of rawItems) {
      if (!raw.text || typeof raw.text !== 'string') continue;
      const text = raw.text.trim();
      if (text.length < 5 || seen.has(text)) continue;
      seen.add(text);

      const kind: KnowledgeItemKind =
        raw.kind === 'decision' || raw.kind === 'observation' || raw.kind === 'experience'
          ? raw.kind
          : 'experience';

      // 定位原文行号
      let matchedLine = 1;
      let matchedSnippet = '';
      if (raw.sourceSentence && typeof raw.sourceSentence === 'string') {
        const needle = raw.sourceSentence.trim().slice(0, 30);
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(needle)) {
            matchedLine = i + 1;
            matchedSnippet = lines[i].trim();
            break;
          }
        }
      }

      const chunk = findChunkForLine(chunks, matchedLine);
      if (!chunk) continue;

      const { matchedIds, matchedNames } = linkDocEntities(text, entities);

      drafts.push({
        kind,
        status: 'candidate',
        text,
        evidenceChunkId: chunk.id,
        startLine: matchedLine,
        endLine: matchedLine,
        sourceSnippet: matchedSnippet || (chunk.text.split('\n')[0] || '').trim(),
        matchedEntityIds: matchedIds,
        matchedEntityNames: matchedNames,
      });
    }

    return drafts.length > 0 ? drafts : extractDeterministicFromDoc(doc, content, chunks, entities);
  } catch {
    // LLM 请求失败或超时，无缝回退到确定性提取
    return extractDeterministicFromDoc(doc, content, chunks, entities);
  }
}
