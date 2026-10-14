import { Hono } from 'hono';
import crypto from 'node:crypto';
import type { Runtime } from '../runtime/service.js';
import { RuntimeError } from '../runtime/service.js';
import type { KnowledgeContext, SearchRequest } from '../knowledge/types.js';
import { bindAgentLibraries, getAgentLibraryIds, resolveLibraries } from '../knowledge/libraries.js';
import { chunkWithSpans } from '../knowledge/chunks.js';
import { getExecutionEvidence } from '../knowledge/evidence.js';
import { getProviderStatus, Context7Provider } from '../knowledge/providers.js';

export function createKnowledgeRoutes(runtime: Runtime): Hono {
  const routes = new Hono();

  // 辅助函数：根据 workspaceId 获取并验证上下文
  function getContext(workspaceId: string): { ctx: KnowledgeContext; workspace: any } {
    let ws: any;
    try {
      ws = runtime.workspace(workspaceId);
    } catch {
      throw new RuntimeError('工作区不存在', 404);
    }

    const ctx: KnowledgeContext = {
      workspaceId: ws.id,
      workspacePath: ws.path,
      agentId: 'general',
      role: 'owner',
    };

    // 确保工作区基础库已就绪
    runtime.knowledgeService.attachWorkspace(ctx);

    return { ctx, workspace: ws };
  }

  function getManageableLibraryIds(ctx: KnowledgeContext): string[] {
    const allLibs = runtime.knowledgeService.store.listLibraries();
    return allLibs
      .filter((l) => (l.scope === 'project' && l.workspaceId === ctx.workspaceId) || l.scope === 'public')
      .map((l) => l.id);
  }

  // 1. GET/POST /api/v1/workspaces/:id/knowledge/libraries
  routes.get('/api/v1/workspaces/:id/knowledge/libraries', (context) => {
    const { ctx } = getContext(context.req.param('id'));
    const limit = Math.min(Math.max(Number(context.req.query('limit') || 50), 1), 100);
    const offset = Math.max(Number(context.req.query('offset') || 0), 0);

    const allLibs = runtime.knowledgeService.store.listLibraries();
    const accessibleIds = getManageableLibraryIds(ctx);
    const accessibleLibs = allLibs.filter((l) => accessibleIds.includes(l.id));

    return context.json(accessibleLibs.slice(offset, offset + limit));
  });

  routes.post('/api/v1/workspaces/:id/knowledge/libraries', async (context) => {
    const { ctx } = getContext(context.req.param('id'));
    const body = await context.req.json();
    if (!body.name || typeof body.name !== 'string') {
      return context.json({ error: '知识库名称必填' }, 400);
    }

    const scope = body.scope === 'public' ? 'public' : 'project';
    const role = body.role || (scope === 'project' ? 'project' : 'domain');
    const libId =
      scope === 'project'
        ? `project:${ctx.workspaceId}:${Date.now().toString(36)}`
        : `pub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    const created = runtime.knowledgeService.store.createLibrary({
      id: libId,
      name: body.name.trim(),
      description: body.description || '',
      scope,
      workspaceId: scope === 'project' ? ctx.workspaceId : undefined,
      role,
    });

    return context.json(created, 201);
  });

  // 2. GET/POST /api/v1/workspaces/:id/knowledge/sources
  routes.get('/api/v1/workspaces/:id/knowledge/sources', (context) => {
    const { ctx } = getContext(context.req.param('id'));
    const libraryId = context.req.query('libraryId');
    const limit = Math.min(Math.max(Number(context.req.query('limit') || 50), 1), 100);
    const offset = Math.max(Number(context.req.query('offset') || 0), 0);

    const accessibleIds = getManageableLibraryIds(ctx);

    if (libraryId && !accessibleIds.includes(libraryId)) {
      throw new RuntimeError('知识库不存在或无权访问', 404);
    }

    const sources = runtime.knowledgeService.store.listSources(libraryId);
    const filtered = sources.filter((s) => accessibleIds.includes(s.libraryId));

    return context.json(filtered.slice(offset, offset + limit));
  });

  routes.post('/api/v1/workspaces/:id/knowledge/sources', async (context) => {
    const { ctx } = getContext(context.req.param('id'));
    const body = await context.req.json();
    if (!body.libraryId || !body.locator) {
      return context.json({ error: 'libraryId 和 locator 必填' }, 400);
    }

    const accessibleIds = getManageableLibraryIds(ctx);
    if (!accessibleIds.includes(body.libraryId)) {
      throw new RuntimeError('目标知识库不存在或无权访问', 404);
    }

    const existing = runtime.knowledgeService.store
      .listSources(body.libraryId)
      .find((s) => s.locator === body.locator);
    if (existing) {
      if (body.enabled && !existing.enabled) {
        runtime.knowledgeService.store.updateSource(existing.id, { enabled: true });
        await runtime.knowledgeService.enableSource(ctx, existing.id);
      } else if (body.enabled) {
        await runtime.knowledgeService.syncSource(ctx, existing.id);
      }
      return context.json(runtime.knowledgeService.store.getSource(existing.id), 200);
    }

    const sourceId = `src-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const created = runtime.knowledgeService.store.createSource({
      id: sourceId,
      libraryId: body.libraryId,
      kind: body.kind || 'local',
      locator: body.locator,
      enabled: Boolean(body.enabled),
      versionConstraint: body.versionConstraint,
      syncStatus: 'ready',
    });

    if (created.enabled) {
      await runtime.knowledgeService.enableSource(ctx, created.id);
    }

    return context.json(created, 201);
  });

  // 3. POST /api/v1/workspaces/:id/knowledge/discover
  routes.post('/api/v1/workspaces/:id/knowledge/discover', async (context) => {
    const { ctx } = getContext(context.req.param('id'));
    const proposals = await runtime.knowledgeService.discoverSources(ctx);
    return context.json(proposals);
  });

  // 4. PATCH /api/v1/workspaces/:id/knowledge/sources/:sourceId
  routes.patch('/api/v1/workspaces/:id/knowledge/sources/:sourceId', async (context) => {
    const { ctx } = getContext(context.req.param('id'));
    const sourceId = context.req.param('sourceId');
    const source = runtime.knowledgeService.store.getSource(sourceId);
    if (!source) {
      throw new RuntimeError('来源不存在', 404);
    }

    const accessibleIds = getManageableLibraryIds(ctx);
    if (!accessibleIds.includes(source.libraryId)) {
      throw new RuntimeError('来源无权访问', 404);
    }

    const body = await context.req.json();
    const updates: any = {};
    if (typeof body.enabled === 'boolean') updates.enabled = body.enabled;
    if (typeof body.locator === 'string') updates.locator = body.locator;
    if (typeof body.versionConstraint === 'string') updates.versionConstraint = body.versionConstraint;

    const updated = runtime.knowledgeService.store.updateSource(sourceId, updates);
    if (body.enabled === true && !source.enabled) {
      await runtime.knowledgeService.enableSource(ctx, sourceId);
    }

    return context.json(updated);
  });

  // 5. POST /api/v1/workspaces/:id/knowledge/sources/:sourceId/sync
  routes.post('/api/v1/workspaces/:id/knowledge/sources/:sourceId/sync', async (context) => {
    const { ctx } = getContext(context.req.param('id'));
    const sourceId = context.req.param('sourceId');
    const source = runtime.knowledgeService.store.getSource(sourceId);
    if (!source) {
      throw new RuntimeError('来源不存在', 404);
    }

    const accessibleIds = getManageableLibraryIds(ctx);
    if (!accessibleIds.includes(source.libraryId)) {
      throw new RuntimeError('来源无权访问', 404);
    }

    await runtime.knowledgeService.syncSource(ctx, sourceId);
    const reloaded = runtime.knowledgeService.store.getSource(sourceId);
    return context.json({ success: true, source: reloaded });
  });

  // 6. GET/POST /api/v1/workspaces/:id/knowledge/documents
  routes.get('/api/v1/workspaces/:id/knowledge/documents', (context) => {
    const { ctx } = getContext(context.req.param('id'));
    const libraryId = context.req.query('libraryId');
    const sourceId = context.req.query('sourceId');
    const limit = Math.min(Math.max(Number(context.req.query('limit') || 50), 1), 100);
    const offset = Math.max(Number(context.req.query('offset') || 0), 0);

    const accessibleIds = getManageableLibraryIds(ctx);

    if (libraryId && !accessibleIds.includes(libraryId)) {
      throw new RuntimeError('知识库不存在或无权访问', 404);
    }

    const docs = runtime.knowledgeService.store.listDocumentsPaged({
      libraryId,
      sourceId,
      limit,
      offset,
    });

    const filtered = docs.filter((d) => accessibleIds.includes(d.libraryId));
    return context.json(filtered);
  });

  routes.post('/api/v1/workspaces/:id/knowledge/documents', async (context) => {
    const { ctx } = getContext(context.req.param('id'));
    const body = await context.req.json();
    if (!body.libraryId) {
      return context.json({ error: 'libraryId 必填' }, 400);
    }

    const targetProjectLibId = `project:${ctx.workspaceId}`;
    if (body.libraryId !== targetProjectLibId) {
      throw new RuntimeError(`仅允许向当前项目库导入文档 (${targetProjectLibId})`, 403);
    }

    if (body.path && body.content) {
      return context.json({ error: 'path 与 content 只能二选一' }, 400);
    }
    if (!body.path && !body.content) {
      return context.json({ error: 'path 或 content 必须提供其一' }, 400);
    }

    if (body.content && Buffer.byteLength(body.content, 'utf-8') > 1024 * 1024) {
      return context.json({ error: '内容超过 1 MiB 限制' }, 413);
    }

    if (body.path) {
      const sources = runtime.knowledgeService.store.listSources().filter((s) => s.enabled && s.kind === 'local');
      const normalizedPath = body.path.trim().replace(/\\/g, '/').replace(/^\.\//, '');
      const matched = sources.some((s) => {
        const loc = s.locator.trim().replace(/\\/g, '/').replace(/^\.\//, '');
        return loc === '.' || loc === '' || normalizedPath === loc || normalizedPath.startsWith(loc + '/');
      });
      if (!matched) {
        return context.json({ error: '指定的 path 不在已启用的本地来源范围内' }, 400);
      }
    }

    try {
      const result = (await runtime.knowledgeService.dispatch(ctx, {
        op: 'ingest',
        input: {
          path: body.path,
          content: body.content,
          name: body.name || body.path,
          libraryId: body.libraryId,
        },
      })) as any;

      return context.json(result, 201);
    } catch (err: any) {
      if (err.message?.includes('Forbidden')) {
        throw new RuntimeError(err.message, 403);
      }
      throw new RuntimeError(err.message || '导入失败', 400);
    }
  });

  // 7. PATCH/DELETE /api/v1/workspaces/:id/knowledge/documents/:documentId
  routes.patch('/api/v1/workspaces/:id/knowledge/documents/:documentId', async (context) => {
    const { ctx } = getContext(context.req.param('id'));
    const documentId = context.req.param('documentId');
    const doc = runtime.knowledgeService.store.getDocumentById(documentId);
    if (!doc) {
      throw new RuntimeError('文档不存在', 404);
    }

    const source = runtime.knowledgeService.store.getSource(doc.sourceId);
    if (!source) {
      throw new RuntimeError('来源不存在', 404);
    }

    const accessibleIds = getManageableLibraryIds(ctx);
    if (!accessibleIds.includes(source.libraryId)) {
      throw new RuntimeError('无权访问此文档', 404);
    }

    const body = await context.req.json();
    if (typeof body.content !== 'string') {
      return context.json({ error: '新内容必填' }, 400);
    }

    if (Buffer.byteLength(body.content, 'utf-8') > 1024 * 1024) {
      return context.json({ error: '内容超过 1 MiB 限制' }, 413);
    }

    // 编辑 local 文档时创建受管副本
    if (source.kind === 'local') {
      const managedSourceId = `src-managed-${ctx.workspaceId}`;
      let managedSource = runtime.knowledgeService.store.getSource(managedSourceId);
      if (!managedSource) {
        managedSource = runtime.knowledgeService.store.createSource({
          id: managedSourceId,
          libraryId: `project:${ctx.workspaceId}`,
          kind: 'managed',
          locator: 'managed',
          enabled: true,
        });
      }

      const copyKey = `${doc.sourceKey} (副本)`;
      const rawChunks = chunkWithSpans(body.content);
      const hash = crypto.createHash('sha256').update(body.content).digest('hex');

      const result = runtime.knowledgeService.store.publishRevision({
        sourceId: managedSource.id,
        sourceKey: copyKey,
        content: body.content,
        hash,
        expectedPreviousRevisionId: null,
        chunks: rawChunks.map((c) => ({
          text: c.text,
          span: c.span,
          evidenceKind: 'document',
        })),
      });

      return context.json({
        message: '本地源码文档不可直接覆盖，已在项目库创建受管副本',
        derivedFrom: doc.id,
        documentId: result.documentId,
        revisionId: result.revisionId,
      });
    }

    // 受管文档更新新版本
    const rawChunks = chunkWithSpans(body.content);
    const hash = crypto.createHash('sha256').update(body.content).digest('hex');
    const result = runtime.knowledgeService.store.publishRevision({
      sourceId: source.id,
      sourceKey: doc.sourceKey,
      content: body.content,
      hash,
      expectedPreviousRevisionId: doc.activeRevisionId,
      chunks: rawChunks.map((c) => ({
        text: c.text,
        span: c.span,
        evidenceKind: 'document',
      })),
    });

    return context.json(result);
  });

  routes.delete('/api/v1/workspaces/:id/knowledge/documents/:documentId', (context) => {
    const { ctx } = getContext(context.req.param('id'));
    const documentId = context.req.param('documentId');
    const doc = runtime.knowledgeService.store.getDocumentById(documentId);
    if (!doc) {
      throw new RuntimeError('文档不存在', 404);
    }

    const source = runtime.knowledgeService.store.getSource(doc.sourceId);
    if (!source) {
      throw new RuntimeError('来源不存在', 404);
    }

    const accessibleIds = getManageableLibraryIds(ctx);
    if (!accessibleIds.includes(source.libraryId)) {
      throw new RuntimeError('无权访问此文档', 404);
    }

    runtime.knowledgeService.store.deleteDocument(documentId);
    return context.json({ success: true });
  });

  // 8. GET /api/v1/workspaces/:id/knowledge/documents/:documentId/revisions
  routes.get('/api/v1/workspaces/:id/knowledge/documents/:documentId/revisions', (context) => {
    const { ctx } = getContext(context.req.param('id'));
    const documentId = context.req.param('documentId');
    const doc = runtime.knowledgeService.store.getDocumentById(documentId);
    if (!doc) {
      throw new RuntimeError('文档不存在', 404);
    }

    const source = runtime.knowledgeService.store.getSource(doc.sourceId);
    if (!source) {
      throw new RuntimeError('来源不存在', 404);
    }

    const accessibleIds = getManageableLibraryIds(ctx);
    if (!accessibleIds.includes(source.libraryId)) {
      throw new RuntimeError('无权访问此文档', 404);
    }

    const revisions = runtime.knowledgeService.store.listRevisions(documentId);
    return context.json(revisions);
  });

  // 9. PUT /api/v1/workspaces/:id/knowledge/bindings/:agentId
  routes.put('/api/v1/workspaces/:id/knowledge/bindings/:agentId', async (context) => {
    const { ctx } = getContext(context.req.param('id'));
    const agentId = context.req.param('agentId');
    const body = await context.req.json();
    if (!Array.isArray(body.libraryIds)) {
      return context.json({ error: 'libraryIds 必须为字符串数组' }, 400);
    }

    const allLibs = runtime.knowledgeService.store.listLibraries();
    for (const libId of body.libraryIds) {
      if (!allLibs.some((l) => l.id === libId)) {
        throw new RuntimeError(`未知知识库 ID: ${libId}`, 404);
      }
    }

    bindAgentLibraries(runtime.knowledgeService.store.db, agentId, body.libraryIds);
    const updated = getAgentLibraryIds(runtime.knowledgeService.store.db, agentId);
    return context.json({ agentId, libraryIds: updated });
  });

  // 10. POST /api/v1/workspaces/:id/knowledge/search
  routes.post('/api/v1/workspaces/:id/knowledge/search', async (context) => {
    const { ctx } = getContext(context.req.param('id'));
    const body = await context.req.json();
    if (!body.query || typeof body.query !== 'string') {
      return context.json({ error: '搜索词必填' }, 400);
    }

    const searchReq: SearchRequest = {
      query: body.query,
      mode: body.mode === 'experience' ? 'experience' : 'fact',
      topK: Math.min(Math.max(Number(body.topK || 5), 1), 100),
      libraryIds: Array.isArray(body.libraryIds) ? body.libraryIds : undefined,
      includeGraph: Boolean(body.includeGraph),
    };

    const result = await runtime.knowledgeService.search(ctx, searchReq);
    return context.json(result);
  });

  // 11. GET /api/v1/workspaces/:id/knowledge/citations/:citationId
  routes.get('/api/v1/workspaces/:id/knowledge/citations/:citationId', (context) => {
    const { ctx } = getContext(context.req.param('id'));
    const citationId = context.req.param('citationId');
    try {
      const citationView = runtime.knowledgeService.citation(ctx, citationId);
      return context.json(citationView);
    } catch (err: any) {
      if (err.message?.includes('not found') || err.message?.includes('denied')) {
        throw new RuntimeError(err.message, 404);
      }
      throw err;
    }
  });

  // 12. GET /api/v1/workspaces/:id/knowledge/graph?entityId=&hops=
  routes.get('/api/v1/workspaces/:id/knowledge/graph', (context) => {
    const { ctx } = getContext(context.req.param('id'));
    const entityId = context.req.query('entityId');
    const hopsParam = context.req.query('hops');
    const hops: 1 | 2 = hopsParam === '2' ? 2 : 1;
    const result = runtime.knowledgeService.graph(ctx, entityId, hops);
    return context.json(result);
  });

  // 13. GET /api/v1/workspaces/:id/knowledge/graph/evidence?nodeId=
  routes.get('/api/v1/workspaces/:id/knowledge/graph/evidence', (context) => {
    const { ctx } = getContext(context.req.param('id'));
    const nodeId = context.req.query('nodeId');
    if (!nodeId) {
      return context.json({ error: 'nodeId 必填' }, 400);
    }
    const ent = runtime.knowledgeService.store.getEntity(nodeId);
    if (!ent) {
      throw new RuntimeError('实体不存在', 404);
    }
    const accessibleIds = getManageableLibraryIds(ctx);
    if (!accessibleIds.includes(ent.libraryId)) {
      throw new RuntimeError('无权访问此实体', 404);
    }
    const rev = runtime.knowledgeService.store.readRevision(ent.revisionId);
    if (!rev) {
      throw new RuntimeError('版本原文不存在', 404);
    }
    const lines = rev.content.split('\n');
    const snippetLines = lines.slice(Math.max(0, ent.startLine - 1), ent.endLine);
    return context.json({
      entity: ent,
      snippet: snippetLines.join('\n'),
      fullContent: rev.content,
    });
  });

  // 14. GET /api/v1/workspaces/:id/knowledge/items
  routes.get('/api/v1/workspaces/:id/knowledge/items', (context) => {
    const { ctx } = getContext(context.req.param('id'));
    const status = context.req.query('status') as any;
    const items = runtime.knowledgeService.listItems(ctx, status || undefined);
    return context.json(items);
  });

  // 15. POST /api/v1/workspaces/:id/knowledge/items/:itemId/correct
  routes.post('/api/v1/workspaces/:id/knowledge/items/:itemId/correct', async (context) => {
    const { ctx } = getContext(context.req.param('id'));
    const itemId = context.req.param('itemId');
    const body = await context.req.json();
    if (!body.replacement || typeof body.replacement !== 'string') {
      return context.json({ error: 'replacement 必填' }, 400);
    }
    try {
      const corrected = runtime.knowledgeService.correctItem(ctx, itemId, body.replacement);
      return context.json(corrected);
    } catch (err: any) {
      if (err.message?.includes('not found')) {
        throw new RuntimeError(err.message, 404);
      }
      if (err.message?.includes('denied')) {
        throw new RuntimeError(err.message, 403);
      }
      throw err;
    }
  });

  // 16. POST /api/v1/workspaces/:id/knowledge/items/:itemId/share
  routes.post('/api/v1/workspaces/:id/knowledge/items/:itemId/share', async (context) => {
    const { ctx } = getContext(context.req.param('id'));
    const itemId = context.req.param('itemId');
    const body = await context.req.json();
    if (!body.targetLibraryId || typeof body.targetLibraryId !== 'string') {
      return context.json({ error: 'targetLibraryId 必填' }, 400);
    }
    const targetLib = runtime.knowledgeService.store.getLibrary(body.targetLibraryId);
    if (!targetLib || targetLib.scope !== 'public') {
      return context.json({ error: '目标库必须是存在的 public 公共库' }, 400);
    }
    const item = runtime.knowledgeService.store.getKnowledgeItem(itemId);
    if (!item) {
      throw new RuntimeError('条目不存在', 404);
    }
    const accessibleIds = getManageableLibraryIds(ctx);
    if (!accessibleIds.includes(item.libraryId)) {
      throw new RuntimeError('无权访问此条目', 404);
    }

    const shared = runtime.knowledgeService.store.createKnowledgeItem({
      id: `shared-${item.id}-${Date.now().toString(36)}`,
      kind: item.kind,
      status: item.status,
      text: item.text,
      libraryId: targetLib.id,
      evidenceIds: item.evidenceIds,
      applicability: item.applicability,
      originRunId: item.originRunId,
      supersedes: item.supersedes,
    });
    return context.json(shared, 201);
  });

  // 17. GET /api/v1/workspaces/:id/knowledge/evidence/:executionId
  routes.get('/api/v1/workspaces/:id/knowledge/evidence/:executionId', (context) => {
    getContext(context.req.param('id'));
    const executionId = context.req.param('executionId');
    const evidence = getExecutionEvidence(runtime.knowledgeService.store.db, executionId);
    if (!evidence) {
      throw new RuntimeError('执行证据不存在', 404);
    }
    return context.json(evidence);
  });

  // 18. GET /api/v1/workspaces/:id/knowledge/providers
  routes.get('/api/v1/workspaces/:id/knowledge/providers', (context) => {
    getContext(context.req.param('id'));
    return context.json(getProviderStatus());
  });

  // 19. POST /api/v1/workspaces/:id/knowledge/providers/context7/preview
  routes.post('/api/v1/workspaces/:id/knowledge/providers/context7/preview', async (context) => {
    getContext(context.req.param('id'));
    const body = await context.req.json();
    if (!body.query || typeof body.query !== 'string') {
      return context.json({ error: 'query 必填' }, 400);
    }
    const provider = new Context7Provider();
    try {
      const results = await provider.preview({
        query: body.query,
        library: body.library,
        version: body.version,
      });
      return context.json(results);
    } catch (err: any) {
      throw new RuntimeError(err.message || 'Context7 预览请求失败', 502);
    }
  });

  // 20. POST /api/v1/workspaces/:id/knowledge/legacy/import
  routes.post('/api/v1/workspaces/:id/knowledge/legacy/import', async (context) => {
    const { ctx } = getContext(context.req.param('id'));
    const body = (await context.req.json().catch(() => ({}))) as any;
    try {
      const result = await runtime.knowledgeService.importLegacyDatabase(ctx, body.legacyDbPath);
      return context.json(result);
    } catch (err: any) {
      throw new RuntimeError(err.message || '旧版知识库导入失败', 400);
    }
  });

  // 21. POST /api/v1/workspaces/:id/knowledge/documents/:documentId/extract/preview
  routes.post('/api/v1/workspaces/:id/knowledge/documents/:documentId/extract/preview', async (context) => {
    const { ctx } = getContext(context.req.param('id'));
    const documentId = context.req.param('documentId');
    try {
      const drafts = await runtime.knowledgeService.previewExtractDocument(ctx, documentId);
      return context.json(drafts);
    } catch (err: any) {
      if (err.message?.includes('not found') || err.message?.includes('denied')) {
        throw new RuntimeError(err.message, 404);
      }
      throw new RuntimeError(err.message || '提取预览失败', 400);
    }
  });

  // 22. POST /api/v1/workspaces/:id/knowledge/documents/:documentId/extract/commit
  routes.post('/api/v1/workspaces/:id/knowledge/documents/:documentId/extract/commit', async (context) => {
    const { ctx } = getContext(context.req.param('id'));
    const documentId = context.req.param('documentId');
    const body = await context.req.json();
    if (!Array.isArray(body.items)) {
      return context.json({ error: 'items 必须为数组' }, 400);
    }
    try {
      const items = runtime.knowledgeService.commitExtractedDocItems(ctx, documentId, body.items);
      return context.json(items, 201);
    } catch (err: any) {
      if (err.message?.includes('not found') || err.message?.includes('denied')) {
        throw new RuntimeError(err.message, 404);
      }
      throw new RuntimeError(err.message || '保存提炼条目失败', 400);
    }
  });

  // 23. POST /api/v1/workspaces/:id/knowledge/extract-docs/preview
  routes.post('/api/v1/workspaces/:id/knowledge/extract-docs/preview', async (context) => {
    const { ctx } = getContext(context.req.param('id'));
    const body = (await context.req.json().catch(() => ({}))) as any;
    try {
      const results = await runtime.knowledgeService.previewExtractAllDocs(ctx, body.libraryId);
      return context.json(results);
    } catch (err: any) {
      throw new RuntimeError(err.message || '批量提取预览失败', 400);
    }
  });

  return routes;
}
