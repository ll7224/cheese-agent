import type Database from 'better-sqlite3';

/**
 * 初始化知识中心关系表 Schema。
 * 覆盖文档、版本、片段引用、图实体、边、沉淀条目以及全局 generation 计数器。
 */
export function initKnowledgeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS libraries (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      scope TEXT NOT NULL,
      workspace_id TEXT,
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      library_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      locator TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      version_constraint TEXT,
      sync_status TEXT NOT NULL DEFAULT 'ready',
      last_sync_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      active_revision_id TEXT,
      status TEXT NOT NULL DEFAULT 'effective',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(source_id, source_key)
    );

    CREATE TABLE IF NOT EXISTS revisions (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      content TEXT NOT NULL,
      hash TEXT NOT NULL,
      commit_hash TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunk_refs (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      chunk_id TEXT NOT NULL,
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      evidence_kind TEXT NOT NULL DEFAULT 'document'
    );

    CREATE INDEX IF NOT EXISTS idx_chunk_refs_doc ON chunk_refs(document_id);
    CREATE INDEX IF NOT EXISTS idx_chunk_refs_rev ON chunk_refs(revision_id);
    CREATE INDEX IF NOT EXISTS idx_chunk_refs_chunk ON chunk_refs(chunk_id);

    CREATE TABLE IF NOT EXISTS bindings (
      agent_id TEXT NOT NULL,
      library_id TEXT NOT NULL,
      PRIMARY KEY(agent_id, library_id)
    );

    CREATE TABLE IF NOT EXISTS workspace_bindings (
      workspace_id TEXT NOT NULL,
      library_id TEXT NOT NULL,
      PRIMARY KEY(workspace_id, library_id)
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_bindings_lib ON workspace_bindings(library_id);
    CREATE INDEX IF NOT EXISTS idx_workspace_bindings_ws ON workspace_bindings(workspace_id);

    INSERT OR IGNORE INTO workspace_bindings (workspace_id, library_id)
    SELECT workspace_id, id FROM libraries
    WHERE workspace_id IS NOT NULL AND workspace_id != '';

    CREATE TABLE IF NOT EXISTS generation (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL DEFAULT 1
    );

    INSERT OR IGNORE INTO generation (id, version) VALUES (1, 1);

    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      path TEXT NOT NULL,
      container TEXT,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      library_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_entities_scope ON entities(workspace_id, path);
    CREATE INDEX IF NOT EXISTS idx_entities_rev ON entities(revision_id);

    CREATE TABLE IF NOT EXISTS edges (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'effective',
      library_id TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);

    CREATE TABLE IF NOT EXISTS edge_evidence (
      id TEXT PRIMARY KEY,
      edge_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      start_offset INTEGER,
      end_offset INTEGER,
      start_line INTEGER,
      end_line INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_edge_evidence_edge ON edge_evidence(edge_id);
    CREATE INDEX IF NOT EXISTS idx_edge_evidence_rev ON edge_evidence(revision_id);

    CREATE TABLE IF NOT EXISTS knowledge_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      text TEXT NOT NULL,
      library_id TEXT NOT NULL,
      evidence_ids TEXT NOT NULL,
      applicability TEXT,
      origin_run_id TEXT,
      supersedes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS capture_jobs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS execution_evidence (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      command TEXT NOT NULL,
      cwd TEXT NOT NULL,
      exit_code INTEGER,
      timed_out INTEGER NOT NULL,
      stdout TEXT NOT NULL,
      stderr TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_exec_evidence_run ON execution_evidence(run_id);
  `);
}
