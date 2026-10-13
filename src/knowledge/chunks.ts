import type { SourceSpan } from './types.js';

export interface ChunkWithSpan {
  text: string;
  span: SourceSpan;
}

/**
 * 将文本切分为带有准确字符偏移和 1-based 行号的片段。
 * 目标片段约 1,200 字符，硬上限 2,000 字符。
 * 优先在段落边界（\n\n）或行边界（\n）切割，不进行任何 trim 或篡改，确保 span 与原文 100% 对应。
 */
export function chunkWithSpans(
  content: string,
  targetSize: number = 1200,
  maxSize: number = 2000
): ChunkWithSpan[] {
  if (!content) return [];

  // 计算每一行起始偏移量以快速换算行号 (1-based)
  const lineStartOffsets: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') {
      lineStartOffsets.push(i + 1);
    }
  }

  function getLineNumber(offset: number): number {
    let low = 0;
    let high = lineStartOffsets.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (lineStartOffsets[mid] <= offset) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return high + 1; // 1-based
  }

  const chunks: ChunkWithSpan[] = [];
  let currentOffset = 0;
  const totalLength = content.length;

  while (currentOffset < totalLength) {
    const remaining = totalLength - currentOffset;
    if (remaining <= maxSize) {
      const start = currentOffset;
      const end = totalLength;
      chunks.push({
        text: content.slice(start, end),
        span: {
          startOffset: start,
          endOffset: end,
          startLine: getLineNumber(start),
          endLine: getLineNumber(Math.max(start, end - 1)),
        },
      });
      break;
    }

    // 寻找最佳断点：在 [targetSize * 0.7, maxSize] 窗口寻找 \n\n 或 \n
    const searchStart = currentOffset + Math.floor(targetSize * 0.7);
    const searchEnd = Math.min(totalLength, currentOffset + maxSize);

    let splitIndex = -1;

    // 1. 尝试段落分界 \n\n
    const paragraphBreak = content.lastIndexOf('\n\n', searchEnd);
    if (paragraphBreak >= searchStart) {
      splitIndex = paragraphBreak + 2; // 包含换行
    } else {
      // 2. 尝试换行符 \n
      const lineBreak = content.lastIndexOf('\n', searchEnd);
      if (lineBreak >= searchStart) {
        splitIndex = lineBreak + 1;
      } else {
        // 3. 尝试标点符号或空格
        const spaceBreak = content.lastIndexOf(' ', searchEnd);
        if (spaceBreak >= searchStart) {
          splitIndex = spaceBreak + 1;
        } else {
          // 4. 硬截断
          splitIndex = searchEnd;
        }
      }
    }

    const start = currentOffset;
    const end = splitIndex;
    chunks.push({
      text: content.slice(start, end),
      span: {
        startOffset: start,
        endOffset: end,
        startLine: getLineNumber(start),
        endLine: getLineNumber(Math.max(start, end - 1)),
      },
    });

    // 允许约 2 行适度重叠以保留上下文（若剩余充足）
    let nextStart = end;
    if (end < totalLength) {
      // 找到最后两行的起始位置
      let overlapCount = 0;
      let p = end - 1;
      while (p > start && overlapCount < 2) {
        if (content[p] === '\n') {
          overlapCount++;
        }
        p--;
      }
      if (overlapCount >= 2 && p + 2 > start && p + 2 < end) {
        nextStart = p + 2;
      }
    }

    if (nextStart <= currentOffset) {
      // 防止死循环
      nextStart = end;
    }
    currentOffset = nextStart;
  }

  return chunks;
}
