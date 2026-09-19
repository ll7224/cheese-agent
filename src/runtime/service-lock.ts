import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function acquireServiceLock(directory: string): () => void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'service.lock');
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
  try {
    writeFileSync(path, owner, { flag: 'wx', mode: 0o600 });
  } catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`数据目录正在使用或上次服务未正常退出：${path}。确认原服务已退出后删除该锁文件再启动，勿删除 state.json。`);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { if (readFileSync(path, 'utf8') === owner) unlinkSync(path); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  };
}
