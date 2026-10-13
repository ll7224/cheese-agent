import path from 'node:path';
import fs from 'node:fs';
import { KnowledgeStore } from './store.js';
import { LocalSyncManager, type EmbeddingFn } from './local-sync.js';
import { discoverWorkspaceSources } from './sources.js';
import {
  executeSearch,
  getCitationView,
  executeIngest,
} from './retriever.js';
import { queryGraph } from './graph.js';
import type {
  KnowledgeContext,
  SourceProposal,
  Source,
  SearchRequest,
  SearchResponse,
  CitationView,
  KnowledgeRequest,
  GraphView,
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
    await this.localSync.close();
    this.store.close();
  }
}
