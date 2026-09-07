/**
 * 向量维度配置。
 * 阿里云百炼 DashScope text-embedding-v3 模型支持通过 MRL 截断指定输出维度，
 * 官方白名单参数仅允许: [256, 512, 768, 1024, 1536, 2048, 2560]。
 * 这里采用行业推荐的通用标准 1024 维（兼顾语义表征精度与检索速度）。
 */
const DIMS = 1024;

/**
 * 统一的向量化函数类型定义：
 * 接收一组文本数组，异步返回对应顺序的二维浮点数向量数组（每个元素是一个长度为 DIMS 的数组）。
 */
export type EmbeddingFn = (texts: string[]) => Promise<number[][]>;

/**
 * 创建离线本地测试用的 Mock Embedder。
 * 无需网络请求和 API Key，利用伪哈希算法将文本映射为确定性的归一化向量，适合本地测试和单元测试。
 */
export function createMockEmbedder(): EmbeddingFn {
  return async (texts: string[]) => texts.map(mockEmbed);
}

/**
 * 创建阿里云百炼（DashScope）OpenAI 兼容接口的真实 Embedder。
 * 模型采用 text-embedding-v3。
 *
 * @param apiKey DashScope API Key
 */
export function createDashScopeEmbedder(apiKey: string): EmbeddingFn {
  return async (texts: string[]) => {
    const resp = await fetch(
      'https://ws-8bdsstzkggbjisx7.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/embeddings',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'qwen3.7-text-embedding',
          input: texts,
          dimensions: DIMS, // 指定降维维度
        }),
      },
    );

    if (!resp.ok) {
      throw new Error(`Embedding API error: ${resp.status} ${await resp.text()}`);
    }

    const data = (await resp.json()) as any;
    // 从 API 返回的标准 OpenAI 格式结构（data.data[i].embedding）中提取纯向量数组
    return data.data.map((d: any) => d.embedding as number[]);
  };
}

/**
 * 内存级文本向量缓存（Cache-aside 模式）：
 * 避免同一批文档或频繁复用的 Query 重复发起昂贵且耗时的 Embedding 远程请求。
 */
const embedCache = new Map<string, number[]>();

/**
 * 带有“内存缓存 + 差量批处理”的高性能向量化包装器。
 *
 * 执行流程：
 * 1. 遍历待向量化文本，已命中的直接从 `embedCache` 取出填入对应原位置；
 * 2. 仅将未命中的文本（uncached）收集起来，一次性批量调用 `fn` 发起网络请求；
 * 3. 批量拿到结果后，回填至内存缓存，并按原数组下标（idx）组装回最终完整结果。
 *
 * @param fn 实际执行向量化的函数（Mock 或 DashScope 等）
 * @param texts 待向量化的文本数组
 * @returns 与入参顺序严格一一对应的向量数组
 */
export async function embed(fn: EmbeddingFn, texts: string[]): Promise<number[][]> {
  const results: number[][] = new Array(texts.length);
  // 记录未命中缓存的条目及其在原数组中的下标，以便请求后精准归位
  const uncached: { idx: number; text: string }[] = [];

  // --- 步骤 1：查询缓存 ---
  for (let i = 0; i < texts.length; i++) {
    const cached = embedCache.get(texts[i]);
    if (cached) {
      results[i] = cached;
    } else {
      uncached.push({ idx: i, text: texts[i] });
    }
  }

  // --- 步骤 2：对未命中缓存的文本进行批量外部请求 ---
  if (uncached.length > 0) {
    const vectors = await fn(uncached.map((u) => u.text));

    // --- 步骤 3：写入缓存并组装最终结果 ---
    for (let i = 0; i < uncached.length; i++) {
      results[uncached[i].idx] = vectors[i];
      embedCache.set(uncached[i].text, vectors[i]);
    }
  }

  return results;
}

/**
 * 辅助算法：本地确定性伪向量生成（用于 Mock 测试）。
 *
 * 特点：
 * 1. 相同文本输入必定产生完全相同的向量输出；
 * 2. 引入双散列槽位分布（`i % DIMS` 与 `(i * 7 + 13) % DIMS`）模拟维度的特征弥散；
 * 3. 最终通过 L2 范数（欧几里得范数）归一化，输出单位向量（模长为 1），方便做余弦相似度计算。
 */
function mockEmbed(text: string): number[] {
  const vec = new Array(DIMS).fill(0);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    vec[i % DIMS] += code;
    vec[(i * 7 + 13) % DIMS] += code * 0.3;
  }

  // 计算 L2 范数（模长），如果全零则保底为 1 防止除以零
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  // 归一化为模长为 1 的单位向量
  return vec.map((v) => v / norm);
}

/**
 * 计算两个等维向量之间的余弦相似度（Cosine Similarity）。
 *
 * 公式：
 *   cos(θ) = (A · B) / (||A|| * ||B||)
 *
 * 返回值范围：[-1, 1]。通常在 Embedding 检索中值越大越接近 1，表示语义越相似。
 *
 * @param a 向量 A
 * @param b 向量 B
 * @returns 相似度分值
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];       // 点积
    normA += a[i] * a[i];     // 模长平方
    normB += b[i] * b[i];     // 模长平方
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

export { DIMS };
