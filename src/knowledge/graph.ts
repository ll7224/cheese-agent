import type { KnowledgeStore } from './store.js';
import type {
  KnowledgeContext,
  GraphView,
  GraphNode,
  GraphEdge,
  KnowledgeStatus,
} from './types.js';
import { resolveLibraries, getAgentLibraryIds, getWorkspaceLibraryIds } from './libraries.js';

/**
 * 执行范围受限的代码结构与局部实体图谱查询。
 * 遵循严格作用域隔离（跨租户实体与证据不可访问）、支持 1 或 2 跳扩展与 60/120 节点上限截断保护。
 */
export function queryGraph(
  store: KnowledgeStore,
  ctx: KnowledgeContext,
  entityId?: string,
  hops: 1 | 2 = 1
): GraphView {
  const allLibraries = store.listLibraries();
  const boundLibIds = getAgentLibraryIds(store.db, ctx.agentId);
  const boundWorkspaceLibIds = getWorkspaceLibraryIds(store.db, ctx.workspaceId);
  const allowedLibraryIds = resolveLibraries(
    allLibraries,
    ctx,
    boundLibIds,
    undefined,
    undefined,
    boundWorkspaceLibIds
  );

  const generation = store.getGeneration();

  if (allowedLibraryIds.length === 0) {
    return {
      generation,
      nodes: [],
      edges: [],
      truncated: false,
    };
  }

  const maxNodes = hops === 2 ? 120 : 60;
  const inClause = allowedLibraryIds.map(() => '?').join(',');

  // 1. 如果没有指定起始 entityId，直接返回当前可访问库内的初始实体及互联边
  if (!entityId || entityId.trim().length === 0) {
    const entityRows = store.db.prepare(`
      SELECT * FROM entities
      WHERE library_id IN (${inClause})
      ORDER BY path ASC, start_line ASC
      LIMIT ?
    `).all(...allowedLibraryIds, maxNodes + 1) as any[];

    const truncated = entityRows.length > maxNodes;
    const finalEntities = truncated ? entityRows.slice(0, maxNodes) : entityRows;

    const nodeIds = new Set(finalEntities.map((e) => e.id));
    const nodes: GraphNode[] = finalEntities.map((e) => ({
      id: e.id,
      name: e.name,
      kind: e.kind,
      path: e.path,
      container: e.container || undefined,
      libraryId: e.library_id,
      revisionId: e.revision_id,
      startLine: e.start_line,
      endLine: e.end_line,
    }));

    if (nodes.length === 0) {
      return { generation, nodes: [], edges: [], truncated: false };
    }

    // 提取这些节点之间的边
    const edgeRows = store.db.prepare(`
      SELECT * FROM edges
      WHERE library_id IN (${inClause})
    `).all(...allowedLibraryIds) as any[];

    const edges: GraphEdge[] = [];
    for (const r of edgeRows) {
      if (nodeIds.has(r.source_id) && nodeIds.has(r.target_id)) {
        edges.push({
          id: r.id,
          source: r.source_id,
          target: r.target_id,
          kind: r.kind,
          status: r.status as KnowledgeStatus,
        });
      }
    }

    return { generation, nodes, edges, truncated };
  }

  // 2. 指定了起始 entityId，优先精确匹配 ID，降级按 path 或 name 查找根实体
  const rootRow = store.db.prepare(`
    SELECT * FROM entities
    WHERE (id = ? OR path = ? OR name = ?)
      AND library_id IN (${inClause})
    LIMIT 1
  `).get(entityId, entityId, entityId, ...allowedLibraryIds) as any;

  if (!rootRow) {
    // 找不到根节点或该节点不属于当前上下文允许的库范围
    return {
      generation,
      nodes: [],
      edges: [],
      truncated: false,
    };
  }

  const visitedNodes = new Map<string, GraphNode>();
  const visitedEdges = new Map<string, GraphEdge>();
  let truncated = false;

  visitedNodes.set(rootRow.id, {
    id: rootRow.id,
    name: rootRow.name,
    kind: rootRow.kind,
    path: rootRow.path,
    container: rootRow.container || undefined,
    libraryId: rootRow.library_id,
    revisionId: rootRow.revision_id,
    startLine: rootRow.start_line,
    endLine: rootRow.end_line,
  });

  let currentFrontier = [rootRow.id];

  for (let step = 0; step < hops; step++) {
    if (currentFrontier.length === 0 || truncated) break;

    const nextFrontier: string[] = [];

    for (const currId of currentFrontier) {
      // 查找与当前节点相连的所有受权边
      const connectedEdges = store.db.prepare(`
        SELECT * FROM edges
        WHERE (source_id = ? OR target_id = ?)
          AND library_id IN (${inClause})
      `).all(currId, currId, ...allowedLibraryIds) as any[];

      for (const e of connectedEdges) {
        const neighborId = e.source_id === currId ? e.target_id : e.source_id;

        // 验证邻居实体在可访问库范围内
        const neighborEntity = store.db.prepare(`
          SELECT * FROM entities
          WHERE id = ? AND library_id IN (${inClause})
        `).get(neighborId, ...allowedLibraryIds) as any;

        if (neighborEntity) {
          if (!visitedNodes.has(neighborEntity.id)) {
            if (visitedNodes.size >= maxNodes) {
              truncated = true;
              break;
            }

            visitedNodes.set(neighborEntity.id, {
              id: neighborEntity.id,
              name: neighborEntity.name,
              kind: neighborEntity.kind,
              path: neighborEntity.path,
              container: neighborEntity.container || undefined,
              libraryId: neighborEntity.library_id,
              revisionId: neighborEntity.revision_id,
              startLine: neighborEntity.start_line,
              endLine: neighborEntity.end_line,
            });

            nextFrontier.push(neighborEntity.id);
          }

          visitedEdges.set(e.id, {
            id: e.id,
            source: e.source_id,
            target: e.target_id,
            kind: e.kind,
            status: e.status as KnowledgeStatus,
          });
        }
      }

      if (truncated) break;
    }

    currentFrontier = nextFrontier;
  }

  return {
    generation,
    nodes: Array.from(visitedNodes.values()),
    edges: Array.from(visitedEdges.values()),
    truncated,
  };
}
