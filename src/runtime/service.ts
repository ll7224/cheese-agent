import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, realpathSync, statSync, accessSync, constants } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import type { ModelMessage } from 'ai';
import { executeWorker } from './worker-client.js';

export interface Workspace { id: string; path: string; name: string }
export interface Session { id: string; workspaceId: string; title: string; updatedAt: string; messages: ModelMessage[] }
export interface Run { id: string; sessionId: string; key: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'stopping' | 'cancelled' | 'interrupted'; error?: string }
interface State { workspaces: Workspace[]; sessions: Session[]; runs: Run[] }
export interface Execution { cwd: string; messages: ModelMessage[]; config?: unknown }
export type Executor = (execution: Execution) => Promise<ModelMessage[]>;
export class RuntimeError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export class Runtime {
  state: State;
  private file: string;
  private jobs = new Set<Promise<void>>();

  constructor(dataDir: string, private executor: Executor = executeWorker) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = join(dataDir, 'state.json');
    this.state = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : { workspaces: [], sessions: [], runs: [] };
  }

  private save() {
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(temporary, this.file);
  }

  addWorkspace(path: string) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new RuntimeError('请输入本机文件夹的绝对路径');
    let canonical: string;
    try {
      canonical = realpathSync(path);
      if (!statSync(canonical).isDirectory()) throw new Error();
    } catch { throw new RuntimeError('目录不存在或不可访问'); }
    const existing = this.state.workspaces.find(workspace => workspace.path === canonical);
    if (existing) return existing;
    const workspace = { id: randomUUID(), path: canonical, name: canonical.split('/').at(-1) || canonical };
    this.state.workspaces.push(workspace);
    this.save();
    return workspace;
  }

  workspace(id: string) {
    const workspace = this.state.workspaces.find(item => item.id === id);
    if (!workspace) throw new RuntimeError('工作目录不存在', 404);
    return workspace;
  }

  listWorkspaces() {
    return this.state.workspaces.map(workspace => ({ ...workspace, available: this.available(workspace) }));
  }

  private available(workspace: Workspace) {
    try { accessSync(workspace.path, constants.R_OK | constants.X_OK); return statSync(workspace.path).isDirectory(); }
    catch { return false; }
  }

  createSession(workspaceId: string) {
    if (!this.available(this.workspace(workspaceId))) throw new RuntimeError('工作目录已不可用');
    const session: Session = { id: randomUUID(), workspaceId, title: '新会话', updatedAt: new Date().toISOString(), messages: [] };
    this.state.sessions.push(session);
    this.save();
    return session;
  }

  session(id: string) {
    const session = this.state.sessions.find(item => item.id === id);
    if (!session) throw new RuntimeError('会话不存在', 404);
    return session;
  }

  submit(sessionId: string, text: string, key: string) {
    const session = this.session(sessionId);
    if (typeof text !== 'string' || !text.trim() || typeof key !== 'string' || !key) throw new RuntimeError('消息和请求标识不能为空');
    const duplicate = this.state.runs.find(run => run.sessionId === sessionId && run.key === key);
    if (duplicate) return duplicate;
    if (this.state.runs.some(run => run.sessionId === sessionId && ['queued', 'running', 'stopping'].includes(run.status))) throw new RuntimeError('当前会话已有待完成任务', 409);
    const workspace = this.workspace(session.workspaceId);
    if (!this.available(workspace)) throw new RuntimeError('工作目录已不可用');
    const run: Run = { id: randomUUID(), sessionId, key, status: 'running' };
    session.messages.push({ role: 'user', content: text });
    if (session.title === '新会话') session.title = text.slice(0, 50);
    session.updatedAt = new Date().toISOString();
    this.state.runs.push(run);
    this.save();
    const job = this.execute(run, session, workspace);
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job));
    return run;
  }

  private async execute(run: Run, session: Session, workspace: Workspace) {
    try {
      session.messages = await this.executor({ cwd: workspace.path, messages: structuredClone(session.messages) });
      run.status = 'completed';
    } catch (error) {
      run.status = 'failed';
      run.error = error instanceof Error ? error.message : String(error);
    }
    session.updatedAt = new Date().toISOString();
    this.save();
  }

  async idle() { await Promise.all(this.jobs); }
}
