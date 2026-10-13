import type Database from 'better-sqlite3';
import type { Library, KnowledgeContext, KnowledgeStatus } from './types.js';

/**
 * 将指定 Agent 与一个或多个知识库进行绑定（覆盖已有绑定）。
 */
export function bindAgentLibraries(
  db: Database.Database,
  agentId: string,
  libraryIds: string[]
): void {
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM bindings WHERE agent_id = ?`).run(agentId);
    const insert = db.prepare(`INSERT INTO bindings (agent_id, library_id) VALUES (?, ?)`);
    for (const libId of libraryIds) {
      insert.run(agentId, libId);
    }
  });
  tx();
}

/**
 * 获取指定 Agent 绑定的所有知识库 ID 列表。
 */
export function getAgentLibraryIds(
  db: Database.Database,
  agentId: string
): string[] {
  const rows = db.prepare(`SELECT library_id FROM bindings WHERE agent_id = ?`).all(agentId) as Array<{ library_id: string }>;
  return rows.map((r) => r.library_id);
}

/**
 * 根据调用上下文计算当前可访问的知识库 ID 清单。
 * 组合规则：
 * 1. 当前项目库（project scope 且对应当前 workspaceId）；
 * 2. 公共基础库（public scope 且 role 为 basic）；
 * 3. 当前 Agent 显式绑定的库；
 * 4. 通用 Agent（general）按 query 分词匹配最多 3 个公共领域库（public domain）。
 * 若请求显式指定 requestedIds，则只允许缩小至可访问集合的子集。
 */
export function resolveLibraries(
  allLibraries: Library[],
  ctx: KnowledgeContext,
  boundLibraryIds: string[] = [],
  query?: string,
  requestedIds?: string[]
): string[] {
  const accessibleSet = new Set<string>();

  for (const lib of allLibraries) {
    // 1. 项目专属库
    if (lib.scope === 'project' && lib.workspaceId === ctx.workspaceId) {
      accessibleSet.add(lib.id);
    }
    // 2. 公共基础库
    if (lib.scope === 'public' && lib.role === 'basic') {
      accessibleSet.add(lib.id);
    }
    // 3. Agent 绑定库
    if (boundLibraryIds.includes(lib.id)) {
      accessibleSet.add(lib.id);
    }
  }

  // 4. 通用 Agent 关键词推断公共领域库（至多 3 个）
  if (ctx.agentId === 'general' && query && query.trim().length > 0) {
    const qLower = query.toLowerCase();
    const domainCandidates: Array<{ id: string; score: number }> = [];

    for (const lib of allLibraries) {
      if (lib.scope === 'public' && lib.role === 'domain' && !accessibleSet.has(lib.id)) {
        let score = 0;
        const nameLower = lib.name.toLowerCase();
        const descLower = lib.description.toLowerCase();
        for (const token of qLower.split(/\s+/)) {
          if (!token) continue;
          if (nameLower.includes(token)) score += 2;
          if (descLower.includes(token)) score += 1;
        }
        if (score > 0) {
          domainCandidates.push({ id: lib.id, score });
        }
      }
    }

    domainCandidates.sort((a, b) => b.score - a.score);
    for (const c of domainCandidates.slice(0, 3)) {
      accessibleSet.add(c.id);
    }
  }

  const accessibleIds = Array.from(accessibleSet);

  if (requestedIds && requestedIds.length > 0) {
    for (const id of requestedIds) {
      if (!allLibraries.some((lib) => lib.id === id)) {
        throw new Error(`未知知识库 ID: ${id}`);
      }
    }
    return requestedIds.filter((id) => accessibleSet.has(id));
  }

  return accessibleIds;
}

/**
 * 将已允许的库 ID 与知识状态映射为内部向量/全文索引的分区 collection_id。
 * 格式形如 `${libraryId}:${status}`。
 */
export function resolveIndexKeys(
  accessibleLibraryIds: string[],
  statuses: KnowledgeStatus[]
): string[] {
  const keys: string[] = [];
  for (const libId of accessibleLibraryIds) {
    for (const st of statuses) {
      keys.push(`${libId}:${st}`);
    }
  }
  return keys;
}
