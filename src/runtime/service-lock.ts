import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

export function acquireServiceLock(directory: string): () => void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'service.lock');
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
  const lock = new Database(join(directory, 'service-lock.sqlite'), { timeout: 0 });
  try {
    lock.exec('BEGIN EXCLUSIVE');
    let previous: string | undefined;
    try { previous = readFileSync(path, 'utf8'); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    if (previous !== undefined) {
      let pid: number;
      try {
        pid = JSON.parse(previous).pid;
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error();
      } catch { throw new Error(`服务锁内容损坏：${path}。请确认原服务已退出后再清理锁文件。`); }
      let alive = true;
      try { process.kill(pid, 0); }
      catch (error: any) { if (error.code === 'ESRCH') alive = false; else if (error.code !== 'EPERM') throw error; }
      if (alive) throw new Error(`数据目录正在使用（PID ${pid}）：${path}。请先正常停止原服务再重启。`);
      unlinkSync(path);
    }
    writeFileSync(path, owner, { flag: 'wx', mode: 0o600 });
  } catch (error: any) {
    lock.close();
    if (['SQLITE_BUSY', 'SQLITE_LOCKED', 'EEXIST'].includes(error.code)) throw new Error(`数据目录正在使用：${path}。请先正常停止原服务再重启。`);
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { if (readFileSync(path, 'utf8') === owner) unlinkSync(path); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    finally { lock.close(); }
  };
}
