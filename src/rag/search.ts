import { cosineSimilarity } from './embedder.js';
import type { StoredChunk } from './store.js';
import type { VectorStore } from './store.js';
import type { EmbeddingFn } from './embedder.js';
import { embed } from './embedder.js';

/**
 * 混合检索结果数据结构定义
 */
export interface SearchResult {
  /** 命中的切片详细数据（包含原文、来源、向量等） */
  chunk: StoredChunk;
  /** 最终加权融合得分（经过向量 + BM25 融合与权重折算后的综合分） */
  score: number;
  /** 归一化后的向量余弦相似度得分 [0, 1] */
  vectorScore: number;
  /** 归一化后的 BM25 关键词匹配得分 [0, 1] */
  keywordScore: number;
}

// ---------------------- 检索超参数配置 ----------------------
/** 向量密集检索的权重比重（Dense Retrieval 权重 70%） */
const VECTOR_WEIGHT = 0.7;

/** 关键词稀疏检索的权重比重（BM25 Sparse Retrieval 权重 30%） */
const KEYWORD_WEIGHT = 0.3;

/** 候选池扩增倍数：召回候选池大小 = min(topK * CANDIDATE_MULTIPLIER, 库总数) */
const CANDIDATE_MULTIPLIER = 4;

/**
 * MMR（Maximal Marginal Relevance 最大边界相关）平衡因子 λ：
 * - 取值范围：0 到 1
 * - λ 越大（如 0.7）：越偏向“相关性（Relevance）”
 * - 1 - λ 越大（如 0.3）：越偏向“多样性（Diversity）/ 惩罚冗余”
 */
const MMR_LAMBDA = 0.7;

/**
 * 混合检索核心入口函数（Hybrid Search：Dense Vector + Sparse BM25 + Score Fusion + MMR Rerank）
 *
 * 完整执行流程：
 * 1. 边界检查：若向量库为空，直接返回空结果；
 * 2. 候选池大小确定：按 `topK * 4` 扩大双路各自召回的候选量，防止过早截断潜在优质结果；
 * 3. 双路并行召回：
 *    - 路 1（向量检索）：Query 向量化后，全库计算 Cosine 相似度，截取 Top N；
 *    - 路 2（关键词检索）：Query 分词后，全库计算 BM25 得分，截取 Top N；
 * 4. 分数归一化（Score Normalization）：
 *    - 向量相似度采用 Min-Max 缩放到 [0, 1]；
 *    - BM25 无上限得分采用 Sigmoid 映射到 [0, 1]；
 * 5. 加权分数融合（Score Fusion）：
 *    - 按 Chunk ID 进行 Outer Join（并集融合）；
 *    - 综合得分 = vectorScore * 0.7 + keywordScore * 0.3；
 * 6. MMR 去重重排（Maximal Marginal Relevance）：
 *    - 解决“检索结果同质化”问题，剔除高相似度重复片段，最终选出最具信息增益的 Top K。
 *
 * @param store 向量知识库实例
 * @param embedFn 向量化模型调用函数
 * @param query 用户的检索查询语句
 * @param topK 最终需要返回的最优结果数量（默认 5）
 * @returns 经过 MMR 多样化重排后的 Top K 检索结果
 */
export async function hybridSearch(
  store: VectorStore,
  embedFn: EmbeddingFn,
  query: string,
  topK: number = 5,
): Promise<SearchResult[]> {
  const all = store.getAll();
  // 1. 库为空直接退出
  if (all.length === 0) return [];

  // 计算每路检索需要召回的候选容量（池子稍微放大，给混合融合与重排留足空间）
  const candidateCount = Math.min(topK * CANDIDATE_MULTIPLIER, all.length);

  // ----------------- 路 1：向量密集检索 (Dense Vector Search) -----------------
  // 1.1 将 query 进行向量化
  const [queryVec] = await embed(embedFn, [query]);
  // 1.2 计算与各 chunk 向量的余弦相似度并降序截取
  const vectorResults = all
    .map((chunk) => ({ chunk, score: cosineSimilarity(queryVec, chunk.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, candidateCount);

  // ----------------- 路 2：BM25 关键词检索 (Sparse Keyword Search) -----------------
  // 2.1 对用户 query 进行中文/英文分词
  const queryTerms = tokenize(query);
  const docCount = all.length;
  // 2.2 计算 BM25 词频与逆文档频率得分并降序截取
  const keywordResults = all
    .map((chunk) => ({ chunk, score: bm25Score(queryTerms, chunk.text, docCount, all) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, candidateCount);

  // ----------------- 分数归一化 (Normalization) -----------------
  // 余弦相似度有明确上下界，采用 Min-Max 线性拉伸至 [0, 1]
  const vecNorm = normalizeMinMax(vectorResults.map((r) => r.score));
  // BM25 得分理论上无上界（>=0），采用 Sigmoid Logistic 函数压缩至 (0, 1)
  const kwNorm = normalizeViaSigmoid(keywordResults.map((r) => r.score));

  // ----------------- 双路融合合并 (Candidate Merging & Fusion) -----------------
  const candidates = new Map<string, SearchResult>();

  // 写入路 1（向量检索候选集）
  for (let i = 0; i < vectorResults.length; i++) {
    const id = vectorResults[i].chunk.id;
    candidates.set(id, {
      chunk: vectorResults[i].chunk,
      score: vecNorm[i] * VECTOR_WEIGHT,
      vectorScore: vecNorm[i],
      keywordScore: 0,
    });
  }

  // 融合路 2（关键词检索候选集）
  for (let i = 0; i < keywordResults.length; i++) {
    const id = keywordResults[i].chunk.id;
    const existing = candidates.get(id);
    if (existing) {
      // 双方都命中的交集，累加 BM25 加权分
      existing.keywordScore = kwNorm[i];
      existing.score += kwNorm[i] * KEYWORD_WEIGHT;
    } else {
      // 仅 BM25 命中的条目，作为纯关键词增量候选
      candidates.set(id, {
        chunk: keywordResults[i].chunk,
        score: kwNorm[i] * KEYWORD_WEIGHT,
        vectorScore: 0,
        keywordScore: kwNorm[i],
      });
    }
  }

  // 按加权融合后的总分进行初步降序排序
  const sorted = [...candidates.values()].sort((a, b) => b.score - a.score);

  // ----------------- MMR 多样性重排去重 -----------------
  return mmrSelect(sorted, topK);
}

// ── BM25 算法实现 ──────────────────────────

/**
 * 简易双语分词器：
 * - 统一转小写
 * - 过滤掉特殊符号，保留常用英文单词字符（\w）及中文字符（一-龥）
 * - 按空格切分成 Token，过滤掉单字标点或长度 <= 1 的噪音
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w一-鿿]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/**
 * Okapi BM25 文本相关性打分算法实现。
 *
 * 核心公式：
 *   Score(D, Q) = ∑ IDF(q_i) * (TF(q_i, D) * (k1 + 1)) / (TF(q_i, D) + k1 * (1 - b + b * (|D| / avgdl)))
 *
 * @param queryTerms 检索查询分词后的词列表
 * @param docText 当前待打分文档切片文本
 * @param N 知识库全部切片总数
 * @param allDocs 知识库全部切片列表（用于统计 DF 文档频率）
 */
function bm25Score(queryTerms: string[], docText: string, N: number, allDocs: StoredChunk[]): number {
  // BM25 标准经验参数：
  // k1：控制词频饱和度（Term Frequency Saturation），通常取 1.2~2.0
  const k1 = 1.2;
  // b：控制文档长度归一化程度（Document Length Normalization），通常取 0.75
  const b = 0.75;

  const docTokens = tokenize(docText);
  // 计算平均文档长度（avgdl）
  const avgDl = allDocs.reduce((s, d) => s + tokenize(d.text).length, 0) / (N || 1);
  const dl = docTokens.length;
  let score = 0;

  for (const term of queryTerms) {
    // 1. TF（词频）：该词在当前文档中出现的频次
    const tf = docTokens.filter((t) => t === term).length;
    // 2. DF（文档频率）：全库中包含该词的文档总数
    const df = allDocs.filter((d) => tokenize(d.text).includes(term)).length;

    // 3. IDF（逆文档频率）：基于 Robertson-Sparck Jones 经典平滑公式
    const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

    // 4. 考虑文档长度惩罚的 TF 归一化项
    const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / avgDl)));

    score += idf * tfNorm;
  }

  return score;
}

// ── 分数归一化工具函数 ──────────────────────────

/**
 * Min-Max 线性归一化：将数值映射至 [0, 1] 区间。
 * 公式：(x - min) / (max - min)
 */
function normalizeMinMax(scores: number[]): number[] {
  if (scores.length === 0) return [];
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min || 1; // 防止除以 0
  return scores.map((s) => (s - min) / range);
}

/**
 * Sigmoid 函数归一化：将任意正实数平滑压缩到 (0, 1) 区间。
 * 公式：1 / (1 + e^(-x))
 * 适合用于 BM25 等非负且理论无明确最大值上限的打分体系。
 */
function normalizeViaSigmoid(scores: number[]): number[] {
  return scores.map((s) => 1 / (1 + Math.exp(-s)));
}

// ── MMR（Maximal Marginal Relevance）重排 ──────────────────────

/**
 * 贪心算法实现 MMR 筛选。
 *
 * 核心目标：在保证文档与 Query 高度相关的同时，最大化已选结果间的内容差异度，避免“把同一个事实的 5 个重复段落全塞进 Prompt”。
 *
 * MMR 评分公式：
 *   MMR(d) = λ * Relevance(d) - (1 - λ) * max_{s ∈ Selected} Similarity(d, s)
 *
 * @param results 经过混合加权排序后的候选集列表
 * @param topK 最终需要挑出的数量
 */
export function mmrSelect(results: SearchResult[], topK: number): SearchResult[] {
  if (results.length <= topK) return results;

  // 1. 无条件将初筛得分最高的那条作为基准入选
  const selected: SearchResult[] = [results[0]];
  const remaining = results.slice(1);

  // 2. 迭代挑选剩余候选集中 MMR 得分最高的切片，直到凑满 topK
  while (selected.length < topK && remaining.length > 0) {
    let bestIdx = 0;
    let bestMmr = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const relevance = remaining[i].score;
      // 计算当前候选与所有“已经入选列表”的切片之间的最大文本相似度
      const maxSim = Math.max(
        ...selected.map((s) => jaccardSimilarity(s.chunk.text, remaining[i].chunk.text)),
      );

      // 计算综合 MMR 得分：鼓励相关性（relevance），惩罚相似度（maxSim）
      const mmr = MMR_LAMBDA * relevance - (1 - MMR_LAMBDA) * maxSim;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = i;
      }
    }

    // 将本轮最具信息增益的切片移入已选集
    selected.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }

  return selected;
}

/**
 * Jaccard 词集合相似度计算：
 * 用于衡量两段文本的词汇重叠度，用来作为 MMR 判重的轻量级度量衡。
 *
 * 公式：
 *   Jaccard(A, B) = |A ∩ B| / |A ∪ B|
 */
function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  const intersection = [...setA].filter((t) => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}
