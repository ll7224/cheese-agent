/**
 * 切片（Chunk）的数据结构定义
 */
export interface Chunk {
  /** 唯一标识符，格式通常为：文档来源#序号，例如："doc.md#0" */
  id: string;
  /** 当前切片的纯文本内容 */
  text: string;
  /** 所属文档或数据源名称（如文件路径、URL 等） */
  source: string;
  /** 该 Chunk 在原文中的顺序索引（从 0 开始递增） */
  index: number;
  /** 预估占用的 Token 数量，用于做上下文预算控制 */
  tokenEstimate: number;
}

// ---------------------- 核心超参数配置 ----------------------
/** 每个 Chunk 的目标 Token 数量（Demo 演示设为 256，生产系统通常推荐 512 或 1024） */
const TARGET_TOKENS = 256;

/** 粗略估算的字符与 Token 转换比例（经验值：英文约 4 字符/Token，代码约 3-4 字符/Token） */
const CHARS_PER_TOKEN = 4;

/** 目标单个分块的最大字符数阈值（256 * 4 = 1024 字符） */
const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN;

/**
 * 将整篇文档文本切分为语义连贯的 Chunk 数组
 *
 * 切分策略（两级回退机制）：
 * 1. 自然段落优先：优先按连续空行（\n{2,}）拆分段落，尽可能保持段落语义完整性。
 * 2. 缓冲池合并：短段落会持续累加在 current 缓冲池中，直到达到目标大小才输出为一个 Chunk。
 * 3. 降级到句子切分：当单个段落本身超过 TARGET_CHARS 时，采用中英文标点断句（。！？.!?）进一步切分。
 *
 * @param source 文档源标识（如文件路径、URL 等）
 * @param text 文档完整纯文本
 * @returns 切分后的 Chunk 列表
 */
export function chunkDocument(source: string, text: string): Chunk[] {
  // 第一步：按连续的空行（>=2 个换行符）将全文拆分为自然段落
  const paragraphs = text.split(/\n{2,}/);
  const chunks: Chunk[] = [];

  // 累积缓冲池：用于将多个较短的段落拼成一个达标大小的 Chunk
  let current = '';
  // Chunk 索引计数器
  let idx = 0;

  for (const para of paragraphs) {
    const trimmed = para.trim();
    // 忽略纯空白段落
    if (!trimmed) continue;

    // --- 条件 1：若当前缓冲池加上新段落会超标，先将缓冲池内容保存为一个 Chunk ---
    // 加 2 是因为段落拼接时通常会补充 '\n\n'（占 2 个字符）
    if (current.length + trimmed.length + 2 > TARGET_CHARS && current.length > 0) {
      chunks.push(makeChunk(source, current.trim(), idx++));
      current = ''; // 清空缓冲池
    }

    // --- 条件 2：如果单个段落本身就超过了最大限制，必须降级做细粒度断句切分 ---
    if (trimmed.length > TARGET_CHARS) {
      // 如果此时缓冲池中还有之前留下的短段落，先将其打包输出
      if (current.length > 0) {
        chunks.push(makeChunk(source, current.trim(), idx++));
        current = '';
      }

      // 第二级降级切分：使用正则后行断言按中英文终止标点（。！？.!?）分句，同时保留标点符号
      const sentences = trimmed.split(/(?<=[。！？.!?])\s*/);
      let sentBuf = '';

      for (const sent of sentences) {
        // 单个句子拼入后若超标，则将当前已累积的句子输出为 Chunk
        if (sentBuf.length + sent.length + 1 > TARGET_CHARS && sentBuf.length > 0) {
          chunks.push(makeChunk(source, sentBuf.trim(), idx++));
          sentBuf = '';
        }
        // 拼接句子（句子之间以空格分隔）
        sentBuf += (sentBuf ? ' ' : '') + sent;
      }

      // 超长段落切分后，剩下的不足一个 Chunk 的尾巴，放回 current 等待与后续段落合并
      if (sentBuf.trim()) {
        current = sentBuf.trim();
      }
    } else {
      // --- 条件 3：正常大小的段落，直接追加到缓冲池中（段落间保留空行） ---
      current += (current ? '\n\n' : '') + trimmed;
    }
  }

  // --- 收尾：如果遍历结束后缓冲池中还有剩余文本，保存为最后一个 Chunk ---
  if (current.trim()) {
    chunks.push(makeChunk(source, current.trim(), idx++));
  }

  return chunks;
}

/**
 * 辅助函数：构造标准化的 Chunk 对象
 *
 * @param source 文档来源
 * @param text Chunk 文本内容
 * @param index 当前切片序号
 */
function makeChunk(source: string, text: string, index: number): Chunk {
  return {
    id: `${source}#${index}`, // 组合出全局唯一的 Chunk ID
    text,
    source,
    index,
    // 向上取整估算 Token 数量
    tokenEstimate: Math.ceil(text.length / CHARS_PER_TOKEN),
  };
}
