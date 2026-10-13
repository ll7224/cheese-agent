import path from 'node:path';
import fs from 'node:fs';
import crypto, { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { KnowledgeStore } from './store.js';
import { LocalSyncManager, type EmbeddingFn } from './local-sync.js';
import { discoverWorkspaceSources } from './sources.js';
import { resolveLibraries } from './libraries.js';
import {
  executeSearch,
  getCitationView,
  executeIngest,
} from './retriever.js';
import { queryGraph } from './graph.js';
import { CaptureQueue, type CaptureInput } from './capture.js';
import {
  Context7Provider,
  FirecrawlProvider,
  syncProviderSource,
  getProviderStatus,
} from './providers.js';
import { chunkWithSpans } from './chunks.js';
import type {
  KnowledgeContext,
  SourceProposal,
  Source,
  SearchRequest,
  SearchResponse,
  CitationView,
  KnowledgeRequest,
  GraphView,
  KnowledgeItem,
  KnowledgeStatus,
} from './types.js';

export interface KnowledgeServiceOptions {
  dataDir: string;
  embedderForWorkspace?: (workspaceId: string) => EmbeddingFn | undefined;
  modelForWorkspace?: (workspaceId: string) => any;
  store?: KnowledgeStore;
}

/**
 * 知识中心核心服务门面。
 * 集中持有 SQLite、来源同步及索引写入。
 */
export class KnowledgeService {
  readonly store: KnowledgeStore;
  readonly localSync: LocalSyncManager;
  readonly captureQueue: CaptureQueue;
  private readonly options: KnowledgeServiceOptions;

  constructor(options: KnowledgeServiceOptions) {
    this.options = options;
    if (options.store) {
      this.store = options.store;
    } else {
      if (!fs.existsSync(options.dataDir)) {
        fs.mkdirSync(options.dataDir, { recursive: true });
      }
      const dbPath = path.join(options.dataDir, 'knowledge.db');
      this.store = new KnowledgeStore(dbPath);
    }

    const defaultEmbedder = options.embedderForWorkspace
      ? options.embedderForWorkspace('default')
      : undefined;

    this.localSync = new LocalSyncManager(this.store, {
      embedder: defaultEmbedder,
    });

    this.captureQueue = new CaptureQueue(this.store, {
      modelForWorkspace: options.modelForWorkspace,
    });
  }

  /**
   * 幂等接入工作区，创建私有 project 库与共享 public-basic 库
   */
  attachWorkspace(ctx: KnowledgeContext): void {
    const projectLibId = `project:${ctx.workspaceId}`;
    if (!this.store.getLibrary(projectLibId)) {
      this.store.createLibrary({
        id: projectLibId,
        name: `Project (${ctx.workspaceId})`,
        description: `Project knowledge library for workspace ${ctx.workspaceId}`,
        scope: 'project',
        workspaceId: ctx.workspaceId,
        role: 'project',
      });
    }

    if (!this.store.getLibrary('public-basic')) {
      this.store.createLibrary({
        id: 'public-basic',
        name: 'Public Basic',
        description: 'Shared public basic knowledge library',
        scope: 'public',
        role: 'basic',
      });
    }
  }

  /**
   * 发现工作区内的候选来源清单并记录（默认保持禁用，不覆盖已有用户的启用/禁用决策）
   */
  async discoverSources(ctx: KnowledgeContext): Promise<SourceProposal[]> {
    this.attachWorkspace(ctx);

    const proposals = await discoverWorkspaceSources(ctx);
    const results: SourceProposal[] = [];

    for (const p of proposals) {
      const existing = this.store.getSource(p.id);
      if (!existing) {
        const created = this.store.createSource({
          id: p.id,
          libraryId: p.libraryId,
          kind: p.kind,
          locator: p.locator,
          enabled: false,
          versionConstraint: p.versionConstraint,
          syncStatus: 'ready',
        });
        results.push({
          ...created,
          sourceId: created.id,
          reason: p.reason,
          enabled: false,
        });
      } else {
        results.push({
          ...existing,
          sourceId: existing.id,
          reason: p.reason,
          enabled: false,
        });
      }
    }

    return results;
  }

  /**
   * 显式启用指定来源，并建立监听与执行初始同步
   */
  async enableSource(ctx: KnowledgeContext, sourceId: string): Promise<void> {
    const source = this.store.getSource(sourceId);
    if (!source) {
      throw new Error(`Source not found: ${sourceId}`);
    }

    // 更新状态为已启用
    this.store.updateSource(sourceId, { enabled: true });
    const enabledSource = this.store.getSource(sourceId)!;

    if (enabledSource.kind === 'local') {
      // 首次启用扫描并建立 watcher；扫描与 watcher ready 后补一次差异同步
      await this.localSync.startWatch(enabledSource, ctx.workspacePath);
      await this.localSync.syncSource(enabledSource, ctx.workspacePath);
    } else if (enabledSource.kind === 'context7' || enabledSource.kind === 'firecrawl') {
      await this.syncSource(ctx, sourceId);
    }
  }

  /**
   * 手动触发指定来源的同步
   */
  async syncSource(ctx: KnowledgeContext, sourceId: string): Promise<void> {
    const source = this.store.getSource(sourceId);
    if (!source) {
      throw new Error(`Source not found: ${sourceId}`);
    }

    if (source.kind === 'local') {
      await this.localSync.syncSource(source, ctx.workspacePath);
    } else if (source.kind === 'context7') {
      const provider = new Context7Provider();
      await syncProviderSource(this.store, source, provider);
    } else if (source.kind === 'firecrawl') {
      const provider = new FirecrawlProvider();
      await syncProviderSource(this.store, source, provider);
    }
  }

  /**
   * 手动导入旧版 RAG 知识库：
   * 仅读取旧 chunks/source/collection，复制到当前项目 legacy 库；
   * source 可读取时重新生成精确 span，不能读取时保留旧文本；
   * 旧库绝不清空，保持原样。
   */
  async importLegacyDatabase(
    ctx: KnowledgeContext,
    legacyDbPath?: string
  ): Promise<{ importedDocuments: number; importedChunks: number; legacyLibraryId: string }> {
    const targetDbPath = legacyDbPath || path.join(ctx.workspacePath, '.cheese-knowledge', 'knowledge.db');
    if (!fs.existsSync(targetDbPath)) {
      throw new Error(`未找到旧版知识库文件: ${targetDbPath}`);
    }

    const legacyDb = new Database(targetDbPath, { readonly: true });
    try {
      const tableCheck = legacyDb.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='chunks'
      `).get();
      if (!tableCheck) {
        throw new Error('旧版数据库缺少 chunks 表，无法导入');
      }

      const rows = legacyDb.prepare(`
        SELECT id, text, source, chunk_index, collection_id FROM chunks
      `).all() as Array<{
        id: string;
        text: string;
        source: string;
        chunk_index: number;
        collection_id?: string;
      }>;

      if (rows.length === 0) {
        return { importedDocuments: 0, importedChunks: 0, legacyLibraryId: '' };
      }

      const legacyLibId = `project:${ctx.workspaceId}:legacy`;
      if (!this.store.getLibrary(legacyLibId)) {
        this.store.createLibrary({
          id: legacyLibId,
          name: `Legacy Imported Knowledge (${ctx.workspaceId})`,
          description: '从旧版 RAG 知识库迁移导入的工程资料',
          scope: 'project',
          workspaceId: ctx.workspaceId,
          role: 'project',
        });
      }

      const sourceId = `src-legacy-${ctx.workspaceId}`;
      let source = this.store.getSource(sourceId);
      if (!source) {
        source = this.store.createSource({
          id: sourceId,
          libraryId: legacyLibId,
          kind: 'managed',
          locator: 'legacy-import',
          enabled: true,
        });
      }

      // 按 source 聚合文档
      const docsMap = new Map<string, Array<{ id: string; text: string; chunk_index: number }>>();
      for (const r of rows) {
        const sKey = r.source || 'unspecified';
        const list = docsMap.get(sKey) || [];
        list.push(r);
        docsMap.set(sKey, list);
      }

      let importedDocuments = 0;
      let importedChunks = 0;

      for (const [sourceKey, chunkList] of docsMap.entries()) {
        chunkList.sort((a, b) => a.chunk_index - b.chunk_index);

        let diskContent: string | null = null;
        const candidateDiskPath = path.isAbsolute(sourceKey)
          ? sourceKey
          : path.join(ctx.workspacePath, sourceKey);
        if (fs.existsSync(candidateDiskPath)) {
          try {
            diskContent = fs.readFileSync(candidateDiskPath, 'utf-8');
          } catch {
            diskContent = null;
          }
        }

        if (diskContent) {
          const rawChunks = chunkWithSpans(diskContent);
          const hash = crypto.createHash('sha256').update(diskContent).digest('hex');
          const existing = this.store.getDocument(source.id, sourceKey);

          this.store.publishRevision({
            sourceId: source.id,
            sourceKey,
            content: diskContent,
            hash,
            expectedPreviousRevisionId: existing?.activeRevisionId || null,
            chunks: rawChunks.map((c) => ({
              text: c.text,
              span: c.span,
              evidenceKind: 'document',
            })),
          });
          importedChunks += rawChunks.length;
        } else {
          const combinedText = chunkList.map((c) => c.text).join('\n\n');
          const hash = crypto.createHash('sha256').update(combinedText).digest('hex');
          const existing = this.store.getDocument(source.id, sourceKey);

          let curOffset = 0;
          let curLine = 1;
          const chunkDrafts = chunkList.map((c) => {
            const startOffset = curOffset;
            const endOffset = curOffset + c.text.length;
            const lineCount = c.text.split('\n').length;
            const startLine = curLine;
            const endLine = curLine + lineCount - 1;
            curOffset = endOffset + 2;
            curLine = endLine + 2;

            return {
              text: c.text,
              span: {
                startOffset,
                endOffset,
                startLine,
                endLine,
              },
              evidenceKind: 'document' as const,
            };
          });

          this.store.publishRevision({
            sourceId: source.id,
            sourceKey,
            content: combinedText,
            hash,
            expectedPreviousRevisionId: existing?.activeRevisionId || null,
            chunks: chunkDrafts,
          });
          importedChunks += chunkDrafts.length;
        }

        importedDocuments++;
      }

      return {
        importedDocuments,
        importedChunks,
        legacyLibraryId: legacyLibId,
      };
    } finally {
      legacyDb.close();
    }
  }

  /**
   * 执行范围受限的混合知识检索
   */
  async search(ctx: KnowledgeContext, request: SearchRequest): Promise<SearchResponse> {
    const embedder = this.options.embedderForWorkspace
      ? this.options.embedderForWorkspace(ctx.workspaceId)
      : undefined;
    return executeSearch(this.store, ctx, request, embedder);
  }

  /**
   * 获取指定引用的原文内容与版本视图
   */
  citation(ctx: KnowledgeContext, id: string): CitationView {
    return getCitationView(this.store, ctx, id);
  }

  /**
   * 查询代码结构与局部实体图谱
   */
  graph(ctx: KnowledgeContext, entityId?: string, hops: 1 | 2 = 1): GraphView {
    return queryGraph(this.store, ctx, entityId, hops);
  }

  /**
   * 异步将执行会话沉淀任务排入队列
   */
  enqueueCapture(ctx: KnowledgeContext, input: CaptureInput): void {
    this.attachWorkspace(ctx);
    this.captureQueue.enqueue(ctx, input);
  }

  /**
   * 列出当前上下文可访问的沉淀条目
   */
  listItems(ctx: KnowledgeContext, status?: KnowledgeStatus): KnowledgeItem[] {
    const allLibs = this.store.listLibraries();
    const accessibleIds = resolveLibraries(allLibs, ctx);
    return this.store.listKnowledgeItems({
      libraryIds: accessibleIds,
      status,
    });
  }

  /**
   * 纠错条目：旧条目 invalidated，并以新文本生成替代条目
   */
  correctItem(ctx: KnowledgeContext, id: string, replacement: string): KnowledgeItem {
    const existing = this.store.getKnowledgeItem(id);
    if (!existing) {
      throw new Error(`Knowledge item not found: ${id}`);
    }

    const allLibs = this.store.listLibraries();
    const accessibleIds = resolveLibraries(allLibs, ctx);
    if (!accessibleIds.includes(existing.libraryId)) {
      throw new Error(`Access denied to knowledge item: ${id}`);
    }

    const newItemId = `item-${randomUUID()}`;
    const now = Date.now();

    const newItem: KnowledgeItem = {
      id: newItemId,
      kind: existing.kind,
      status: 'effective',
      text: replacement,
      libraryId: existing.libraryId,
      evidenceIds: existing.evidenceIds,
      applicability: existing.applicability,
      originRunId: existing.originRunId,
      supersedes: existing.id,
      createdAt: now,
      updatedAt: now,
    };

    const tx = this.store.db.transaction(() => {
      // 1. 将旧条目标记为 invalidated
      this.store.updateKnowledgeItem(existing.id, {
        status: 'invalidated',
        updatedAt: now,
      });

      // 2. 插入新替代条目
      this.store.createKnowledgeItem(newItem);

      // 3. 更新向量/FTS 索引：旧条目退出，新生效条目加入 effective 分区
      this.store.vectorStore.removeChunks([
        `item-chunk-${existing.id}`,
        `chunk-${existing.id}`,
        `chunk-${existing.id.replace(/^item-/, '')}`,
        existing.id,
      ]);
      this.store.vectorStore.upsertIndexedChunks([
        {
          id: `item-chunk-${newItem.id}`,
          text: replacement,
          source: `knowledge-item:${newItem.id}`,
          chunkIndex: 0,
          collectionId: `${existing.libraryId}:effective`,
        },
      ]);

      // 4. 更新相关边并建立 supersedes 关系
      this.store.db.prepare(`
        UPDATE edges SET source_id = ? WHERE source_id = ?
      `).run(newItem.id, existing.id);
      this.store.db.prepare(`
        UPDATE edges SET target_id = ? WHERE target_id = ?
      `).run(newItem.id, existing.id);
      this.store.db.prepare(`
        INSERT OR REPLACE INTO edges (id, source_id, target_id, kind, status, library_id)
        VALUES (?, ?, ?, 'supersedes', 'effective', ?)
      `).run(
        `edge-sup-${newItem.id}-${existing.id}`,
        newItem.id,
        existing.id,
        existing.libraryId
      );

      // 5. 递增 generation
      this.store.db.prepare(`
        UPDATE generation SET version = version + 1 WHERE id = 1
      `).run();
    });
    tx();

    return newItem;
  }

  /**
   * 统一分发 KnowledgeRequest
   */
  async dispatch(ctx: KnowledgeContext, request: KnowledgeRequest): Promise<unknown> {
    if (request.op === 'search') {
      return this.search(ctx, request.input);
    }
    if (request.op === 'citation') {
      return this.citation(ctx, request.input.citationId);
    }
    if (request.op === 'graph') {
      return this.graph(ctx, request.input.entityId, request.input.hops);
    }
    if (request.op === 'ingest') {
      const embedder = this.options.embedderForWorkspace
        ? this.options.embedderForWorkspace(ctx.workspaceId)
        : undefined;
      return executeIngest(this.store, ctx, request.input, embedder);
    }
    throw new Error(`Unknown knowledge op: ${(request as any).op}`);
  }

  /**
   * 关闭所有监听与底层存储连接
   */
  async close(): Promise<void> {
    this.captureQueue.close();
    await this.localSync.close();
    this.store.close();
  }
}
