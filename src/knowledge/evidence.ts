import type Database from 'better-sqlite3';
import type { CommandEvidence } from '../tools/bash.js';

export interface ExecutionEvidenceRecord {
  id: string;
  runId: string;
  executionId: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  timestamp: string;
  createdAt: number;
}

/**
 * 记录单条命令执行证据快照到底层 SQLite
 */
export function saveExecutionEvidence(
  db: Database.Database,
  runId: string,
  evidence: CommandEvidence
): ExecutionEvidenceRecord {
  const createdAt = Date.now();
  const record: ExecutionEvidenceRecord = {
    id: evidence.executionId,
    runId,
    executionId: evidence.executionId,
    command: evidence.command,
    cwd: evidence.cwd,
    exitCode: evidence.exitCode,
    timedOut: Boolean(evidence.timedOut),
    stdout: evidence.stdout || '',
    stderr: evidence.stderr || '',
    timestamp: evidence.timestamp || new Date().toISOString(),
    createdAt,
  };

  db.prepare(`
    INSERT OR REPLACE INTO execution_evidence (
      id, run_id, execution_id, command, cwd, exit_code, timed_out, stdout, stderr, timestamp, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.runId,
    record.executionId,
    record.command,
    record.cwd,
    record.exitCode,
    record.timedOut ? 1 : 0,
    record.stdout,
    record.stderr,
    record.timestamp,
    record.createdAt
  );

  return record;
}

/**
 * 根据 executionId 获取执行证据快照
 */
export function getExecutionEvidence(
  db: Database.Database,
  executionId: string
): ExecutionEvidenceRecord | null {
  const row = db.prepare(`SELECT * FROM execution_evidence WHERE execution_id = ? OR id = ?`).get(executionId, executionId) as any;
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    executionId: row.execution_id,
    command: row.command,
    cwd: row.cwd,
    exitCode: row.exit_code,
    timedOut: Boolean(row.timed_out),
    stdout: row.stdout,
    stderr: row.stderr,
    timestamp: row.timestamp,
    createdAt: row.created_at,
  };
}

/**
 * 列出指定 Run 的所有执行证据快照
 */
export function listExecutionEvidenceByRun(
  db: Database.Database,
  runId: string
): ExecutionEvidenceRecord[] {
  const rows = db.prepare(`SELECT * FROM execution_evidence WHERE run_id = ? ORDER BY created_at ASC`).all(runId) as any[];
  return rows.map((row) => ({
    id: row.id,
    runId: row.run_id,
    executionId: row.execution_id,
    command: row.command,
    cwd: row.cwd,
    exitCode: row.exit_code,
    timedOut: Boolean(row.timed_out),
    stdout: row.stdout,
    stderr: row.stderr,
    timestamp: row.timestamp,
    createdAt: row.created_at,
  }));
}
