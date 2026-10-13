import crypto from 'node:crypto';
import type { KnowledgeStore } from './store.js';
import type { Source, RevisionDraft } from './types.js';
import { chunkWithSpans } from './chunks.js';

export interface ProviderDocument {
  sourceKey: string;
  sourceUrl: string;
  content: string;
  version?: string;
  fetchedAt: string;
  provider: 'context7' | 'firecrawl';
}

export interface PublicSourceProvider {
  readonly provider: 'context7' | 'firecrawl';
  fetch(source: Source, signal?: AbortSignal): Promise<ProviderDocument[]>;
}

export interface ProviderStatus {
  context7: boolean;
  firecrawl: boolean;
}

/**
 * 获取当前环境配置的公开数据提供方可用性状态
 */
export function getProviderStatus(): ProviderStatus {
  return {
    context7: Boolean(process.env.CONTEXT7_API_KEY && process.env.CONTEXT7_API_KEY.trim().length > 0),
    firecrawl: Boolean(process.env.FIRECRAWL_API_KEY && process.env.FIRECRAWL_API_KEY.trim().length > 0),
  };
}

/**
 * Context7 外部文档提供方适配器
 */
export class Context7Provider implements PublicSourceProvider {
  readonly provider = 'context7' as const;
  private readonly apiKey?: string;
  private readonly baseUrl: string;

  constructor(options: { apiKey?: string; baseUrl?: string } = {}) {
    this.apiKey = options.apiKey || process.env.CONTEXT7_API_KEY;
    this.baseUrl = options.baseUrl || process.env.CONTEXT7_ENDPOINT || 'https://api.context7.com';
  }

  /**
   * 预览 Context7 检索或文档结果（不直接发布为 Source，供用户显式选择后保存）
   */
  async preview(
    params: { library?: string; version?: string; query: string },
    signal?: AbortSignal
  ): Promise<ProviderDocument[]> {
    if (!this.apiKey) {
      throw new Error('CONTEXT7_API_KEY 未配置，无法请求 Context7 服务');
    }

    const url = new URL('/v1/documents/search', this.baseUrl);
    url.searchParams.set('query', params.query);
    if (params.library) url.searchParams.set('library', params.library);
    if (params.version) url.searchParams.set('version', params.version);

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      signal,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Context7 请求失败 (${res.status}): ${errBody || res.statusText}`);
    }

    const data = (await res.json()) as any;
    const items = Array.isArray(data) ? data : data.documents || data.results || [];
    const now = new Date().toISOString();

    return items.map((item: any, idx: number) => ({
      sourceKey: item.name || item.title || `context7-doc-${idx}`,
      sourceUrl: item.url || item.sourceUrl || url.toString(),
      content: item.content || item.text || item.markdown || '',
      version: item.version || params.version,
      fetchedAt: now,
      provider: 'context7',
    }));
  }

  /**
   * 拉取指定 Source 配置的文档集
   */
  async fetch(source: Source, signal?: AbortSignal): Promise<ProviderDocument[]> {
    return this.preview(
      {
        query: source.locator,
        version: source.versionConstraint,
      },
      signal
    );
  }
}

/**
 * Firecrawl 网页爬取与同步提供方适配器
 */
export class FirecrawlProvider implements PublicSourceProvider {
  readonly provider = 'firecrawl' as const;
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  readonly maxPages: number;

  constructor(options: { apiKey?: string; baseUrl?: string; maxPages?: number } = {}) {
    this.apiKey = options.apiKey || process.env.FIRECRAWL_API_KEY;
    this.baseUrl = options.baseUrl || process.env.FIRECRAWL_ENDPOINT || 'https://api.firecrawl.dev';
    this.maxPages = options.maxPages || 30;
  }

  async fetch(source: Source, signal?: AbortSignal): Promise<ProviderDocument[]> {
    if (!this.apiKey) {
      throw new Error('FIRECRAWL_API_KEY 未配置，无法请求 Firecrawl 服务');
    }

    // 解析并校验目标 URL
    let targetUrl: URL;
    try {
      targetUrl = new URL(source.locator);
    } catch {
      throw new Error(`Firecrawl 目标定位符不是合法 URL: ${source.locator}`);
    }

    const allowedHost = targetUrl.host;
    const allowedPathPrefix = targetUrl.pathname;

    // 发起爬取作业
    const crawlUrl = new URL('/v1/crawl', this.baseUrl);
    const startRes = await fetch(crawlUrl.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: targetUrl.toString(),
        limit: this.maxPages,
        allowExternalLinks: false, // 严禁外站跳转
      }),
      signal,
    });

    if (!startRes.ok) {
      const errBody = await startRes.text().catch(() => '');
      throw new Error(`Firecrawl 创建爬取任务失败 (${startRes.status}): ${errBody}`);
    }

    const startData = (await startRes.json()) as any;
    const jobId = startData.id || startData.jobId;

    if (!jobId) {
      // 若直接返回了页面数据（单页 scrape 模式）
      const pages = Array.isArray(startData) ? startData : startData.data || [];
      return this.filterAndMapPages(pages, allowedHost, allowedPathPrefix);
    }

    // 有界轮询（最长 60 秒）
    const startTime = Date.now();
    const timeoutMs = 60000;
    const checkUrl = new URL(`/v1/crawl/${jobId}`, this.baseUrl);

    while (Date.now() - startTime < timeoutMs) {
      if (signal?.aborted) {
        throw new Error('Firecrawl 任务已被取消');
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));

      const pollRes = await fetch(checkUrl.toString(), {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal,
      });

      if (!pollRes.ok) {
        const errBody = await pollRes.text().catch(() => '');
        throw new Error(`Firecrawl 轮询状态失败 (${pollRes.status}): ${errBody}`);
      }

      const pollData = (await pollRes.json()) as any;
      const status = pollData.status;

      if (status === 'completed' || status === 'finished') {
        const pages = pollData.data || pollData.results || [];
        return this.filterAndMapPages(pages, allowedHost, allowedPathPrefix);
      }

      if (status === 'failed' || status === 'error') {
        throw new Error(`Firecrawl 爬取作业执行失败: ${pollData.error || '未知错误'}`);
      }
    }

    throw new Error('Firecrawl 爬取任务在 60 秒内未完成，已超时终止');
  }

  /**
   * 过滤并映射爬取页面：
   * 严格验证 host 与 pathPrefix，禁止外站；限制单次最大 30 页。
   */
  private filterAndMapPages(
    pages: any[],
    allowedHost: string,
    allowedPathPrefix: string
  ): ProviderDocument[] {
    const now = new Date().toISOString();
    const results: ProviderDocument[] = [];

    for (const page of pages) {
      if (results.length >= this.maxPages) break;

      const pageUrlStr = page.url || page.sourceUrl;
      if (!pageUrlStr) continue;

      let parsed: URL;
      try {
        parsed = new URL(pageUrlStr);
      } catch {
        continue;
      }

      // 严格域名边界检查：禁止外站
      if (parsed.host !== allowedHost) {
        continue;
      }

      // 严格路径前缀检查
      if (allowedPathPrefix && allowedPathPrefix !== '/' && !parsed.pathname.startsWith(allowedPathPrefix)) {
        continue;
      }

      const content = page.markdown || page.content || page.text || '';
      if (!content || content.trim().length === 0) continue;

      results.push({
        sourceKey: parsed.pathname.replace(/^\//, '') || 'index.html',
        sourceUrl: pageUrlStr,
        content,
        version: page.version,
        fetchedAt: now,
        provider: 'firecrawl',
      });
    }

    return results;
  }
}

/**
 * 同步公开数据源：
 * - 内容 sha256 未变时不重复创建新版本与 embedding
 * - 失败时保留旧数据并记录 lastError
 * - 更新 lastSyncAt
 */
export async function syncProviderSource(
  store: KnowledgeStore,
  source: Source,
  provider: PublicSourceProvider,
  signal?: AbortSignal
): Promise<{ added: number; updated: number; unchanged: number }> {
  try {
    store.updateSource(source.id, { syncStatus: 'syncing' });
    const docs = await provider.fetch(source, signal);

    let added = 0;
    let updated = 0;
    let unchanged = 0;

    for (const doc of docs) {
      const hash = crypto.createHash('sha256').update(doc.content).digest('hex');
      const existingDoc = store.getDocument(source.id, doc.sourceKey);

      if (existingDoc && existingDoc.activeRevisionId) {
        const rev = store.readRevision(existingDoc.activeRevisionId);
        if (rev && rev.hash === hash) {
          // 内容哈希未变，跳过重建
          unchanged++;
          continue;
        }
      }

      const rawChunks = chunkWithSpans(doc.content);
      store.publishRevision({
        sourceId: source.id,
        sourceKey: doc.sourceKey,
        content: doc.content,
        hash,
        expectedPreviousRevisionId: existingDoc?.activeRevisionId || null,
        chunks: rawChunks.map((c) => ({
          text: c.text,
          span: c.span,
          evidenceKind: 'document',
        })),
      });

      if (existingDoc) {
        updated++;
      } else {
        added++;
      }
    }

    store.updateSource(source.id, {
      syncStatus: 'ready',
      lastSyncAt: Date.now(),
      lastError: undefined,
    });

    return { added, updated, unchanged };
  } catch (err: any) {
    store.updateSource(source.id, {
      syncStatus: 'error',
      lastError: err?.message || String(err),
      lastSyncAt: Date.now(),
    });
    throw err;
  }
}
