import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, realpathSync, statSync, accessSync, constants } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import type { ModelMessage } from 'ai';
import { executeWorker } from './worker-client.js';
import { captureConfig, resolveConfig, type ConfigSnapshot } from './config.js';
import { EventEmitter } from 'node:events';
import { redact, collectSecrets, type AgentEvent, type ExecutionEvent } from './events.js';

export interface Workspace { id: string; path: string; name: string }
export interface Session { id: string; workspaceId: string; title: string; updatedAt: string; messages: ModelMessage[]; config?: ConfigSnapshot }
export interface Run { id: string; sessionId: string; key: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'stopping' | 'cancelled' | 'interrupted'; error?: string }
interface State { workspaces: Workspace[]; sessions: Session[]; runs: Run[]; events: ExecutionEvent[] }
export interface Execution { cwd: string; messages: ModelMessage[]; config?: unknown; emit: (event: AgentEvent) => void }
export type Executor = (execution: Execution) => Promise<ModelMessage[]>;
export class RuntimeError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export class Runtime {
  state: State;
  private file: string;
  private jobs = new Set<Promise<void>>();
  private bus = new EventEmitter();
  private storageError?: Error;

  constructor(dataDir: string, private executor: Executor = executeWorker, private options: { configDir?: string } = {}) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = join(dataDir, 'state.json');
    this.state = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : { workspaces: [], sessions: [], runs: [], events: [] };
    this.state.events ||= [];
    this.bus.setMaxListeners(0);
  }

  private save() {
    if (this.storageError) throw this.storageError;
    const temporary = `${this.file}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
      renameSync(temporary, this.file);
    } catch {
      this.storageError = new Error('执行记录无法保存，服务已停止接收任务；请检查磁盘后重启');
      throw this.storageError;
    }
  }

  events(runId: string, after = 0) {
    if (!this.state.runs.some(run => run.id === runId)) throw new RuntimeError('任务不存在', 404);
    return this.state.events.filter(event => event.runId === runId && event.sequence > after);
  }

  subscribe(runId: string, listener: (event: ExecutionEvent) => void) {
    this.bus.on(runId, listener);
    return () => { this.bus.off(runId, listener); };
  }

  private emit(run: Run, event: AgentEvent, secrets: string[] = []) {
    const session = this.session(run.sessionId);
    const entry: ExecutionEvent = { ...redact(event, secrets), id: randomUUID(), runId: run.id, sessionId: session.id, workspaceId: session.workspaceId, sequence: this.events(run.id).length + 1, timestamp: new Date().toISOString() };
    this.state.events.push(entry);
    this.save();
    this.bus.emit(run.id, entry);
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
    const config = captureConfig(this.options.configDir || this.workspace(workspaceId).path, this.workspace(workspaceId).path);
    const session: Session = { id: randomUUID(), workspaceId, title: '新会话', updatedAt: new Date().toISOString(), messages: [], config };
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
    if (this.storageError) throw this.storageError;
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
    this.emit(run, { type: 'status', status: run.status });
    const job = this.execute(run, session, workspace);
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job)).catch(() => {});
    return run;
  }

  private async execute(run: Run, session: Session, workspace: Workspace) {
    let secrets: string[] = [];
    try {
      const config = session.config ? resolveConfig(session.config) : undefined;
      secrets = collectSecrets(config);
      session.messages = redact(await this.executor({ cwd: workspace.path, messages: structuredClone(session.messages), config, emit: event => this.emit(run, event, secrets) }), secrets);
      run.status = 'completed';
    } catch (error) {
      run.status = 'failed';
      run.error = redact(error instanceof Error ? error.message : String(error), secrets);
    }
    session.updatedAt = new Date().toISOString();
    this.emit(run, { type: 'status', status: run.status, error: run.error });
  }

  async idle() { await Promise.all(this.jobs); }
}
