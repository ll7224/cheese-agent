import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, realpathSync, statSync, accessSync, constants, copyFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import type { ModelMessage } from 'ai';
import { executeWorker } from './worker-client.js';
import { captureConfig, resolveConfig, type ConfigSnapshot } from './config.js';
import { EventEmitter } from 'node:events';
import { redact, redactStream, collectSecrets, partialText, type AgentEvent, type ExecutionEvent } from './events.js';
import { Pool } from './pool.js';
import { CronService } from '../cron/service.js';
import { createCronTool } from '../tools/cron-tools.js';
import { ModelStore, type StoredModel, type MaskedModel, testConnection, fetchRemoteModels } from './model-store.js';
import type { CheeseAgentConfig } from '../config/schema.js';

export interface Workspace { id: string; path: string; name: string }
export interface Session { id: string; workspaceId: string; title: string; updatedAt: string; messages: ModelMessage[]; config?: ConfigSnapshot; source?: string; modelId?: string }
export interface Run { id: string; sessionId: string; key: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'stopping' | 'cancelled' | 'interrupted'; error?: string; messageOffset?: number; input?: string }
interface State { workspaces: Workspace[]; sessions: Session[]; runs: Run[]; events: ExecutionEvent[] }
function readState(file: string): State {
  const state = JSON.parse(readFileSync(file, 'utf8'));
  if (!state || !['workspaces', 'sessions', 'runs'].every(key => Array.isArray(state[key])) || (state.events && !Array.isArray(state.events))) throw new Error('无效会话快照');
  if (state.workspaces.some((workspace: any) => !workspace?.id || typeof workspace.path !== 'string') || state.sessions.some((session: any) => !session?.id || !Array.isArray(session.messages) || !state.workspaces.some((workspace: any) => workspace.id === session.workspaceId)) || state.runs.some((run: any) => !run?.id || !state.sessions.some((session: any) => session.id === run.sessionId))) throw new Error('会话快照关联已损坏');
  return state;
}
export interface Execution { cwd: string; messages: ModelMessage[]; config?: unknown; emit: (event: AgentEvent) => void; acquireChild: (id: string) => Promise<() => void>; manageCron: (input: any) => Promise<unknown>; signal: AbortSignal }
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
  private children: Pool;
  private controllers = new Map<string, AbortController>();
  private closing = false;
  private crons = new Map<string, CronService>();
  private cronDirectories = new Map<string, string>();
  private schedulesEnabled = false;
  private recoveredBackup = false;
  modelStore: ModelStore;

  constructor(dataDir: string, private executor: Executor = executeWorker, private options: { configDir?: string; modelDir?: string; maxConcurrent?: number; maxChildren?: number } = {}) {
    const isCustomDataDir = dataDir.includes('cheese-') || dataDir.includes('/tmp') || dataDir.includes('/var/folders');
    const defaultModelDir = isCustomDataDir ? join(dataDir, 'models') : join(homedir(), '.cheese');
    this.modelStore = new ModelStore(options.modelDir || defaultModelDir);
    this.children = new Pool(options.maxChildren ?? 3);
    if (!Number.isInteger(options.maxConcurrent ?? 3) || (options.maxConcurrent ?? 3) < 1) throw new RuntimeError('并发额度必须为正整数');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = join(dataDir, 'state.json');
    try {
      this.state = existsSync(this.file) ? readState(this.file) : { workspaces: [], sessions: [], runs: [], events: [] };
    } catch {
      if (!existsSync(`${this.file}.bak`)) throw new Error('会话存储损坏且无备份；请保留数据文件后恢复备份');
      this.state = readState(`${this.file}.bak`);
      this.recoveredBackup = true;
      console.warn('会话快照损坏，已从上一份备份恢复');
    }
    this.state.events ||= [];
    this.bus.setMaxListeners(0);
    for (const run of this.state.runs) {
      if (!['queued', 'running', 'stopping'].includes(run.status)) continue;
      run.status = 'interrupted';
      run.error = '服务重启，任务已中断；手动继续会创建新任务，不自动重放工具操作';
      this.preservePartial(run);
      const children = new Map<string, ExecutionEvent>();
      this.events(run.id).filter(event => event.type === 'child-status').forEach(event => children.set(String(event.childRunId), event));
      for (const [childRunId, event] of children) if (['queued', 'running', 'stopping'].includes(String(event.status))) this.emit(run, { type: 'child-status', childRunId, status: 'interrupted' });
      this.emit(run, { type: 'status', status: run.status, error: run.error });
    }
  }

  private save() {
    if (this.storageError) throw this.storageError;
    const temporary = `${this.file}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
      if (existsSync(this.file) && !this.recoveredBackup) copyFileSync(this.file, `${this.file}.bak`);
      renameSync(temporary, this.file);
      this.recoveredBackup = false;
    } catch {
      this.storageError = new Error('执行记录无法保存，服务已停止接收任务；请检查磁盘后重启');
      this.controllers.forEach(controller => controller.abort(this.storageError));
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
    return this.state.workspaces.map(workspace => ({
      ...workspace,
      available: this.available(workspace),
      sessionCount: this.state.sessions.filter(item => item.workspaceId === workspace.id).length
    }));
  }

  private available(workspace: Workspace) {
    try { accessSync(workspace.path, constants.R_OK | constants.X_OK); return statSync(workspace.path).isDirectory(); }
    catch { return false; }
  }

  createSession(workspaceId: string, modelId?: string) {
    if (!this.available(this.workspace(workspaceId))) throw new RuntimeError('工作目录已不可用');
    const defaultModel = this.modelStore.getDefault();
    const isModelUsable = (m?: StoredModel) => Boolean(m && (m.apiKey || m.provider === 'ollama' || m.provider === 'mock'));
    const selectedModel = modelId ? this.modelStore.resolveModel(modelId) : (isModelUsable(defaultModel) ? defaultModel : undefined);
    const config = captureConfig(
      this.options.configDir || this.workspace(workspaceId).path,
      this.workspace(workspaceId).path,
      selectedModel
    );
    if (this.schedulesEnabled) {
      try { this.cron(workspaceId, config.values); }
      catch { console.warn(`目录 ${this.workspace(workspaceId).path} 的定时任务未启动，请检查目录配置；普通会话不受影响`); }
    }
    const session: Session = {
      id: randomUUID(),
      workspaceId,
      title: '新会话',
      updatedAt: new Date().toISOString(),
      messages: [],
      config,
      modelId: modelId || selectedModel?.id
    };
    this.state.sessions.push(session);
    this.save();
    return session;
  }

  session(id: string) {
    const session = this.state.sessions.find(item => item.id === id);
    if (!session) throw new RuntimeError('会话不存在', 404);
    return session;
  }

  async runPrompt(workspaceId: string, text: string, source?: string, timeout?: number): Promise<string> {
    const session = (source && this.state.sessions.find(item => item.workspaceId === workspaceId && item.source === source)) || this.createSession(workspaceId);
    if (source) session.source = source;
    const run = this.submit(session.id, text, randomUUID());
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = () => {};
    try {
      await new Promise<void>((resolve, reject) => {
        const check = () => {
          if (run.status === 'completed') resolve();
          else if (['failed', 'cancelled', 'interrupted'].includes(run.status)) reject(new Error(run.error || run.status));
        };
        unsubscribe = this.subscribe(run.id, check);
        if (timeout) timer = setTimeout(() => { this.stop(run.id); }, timeout);
        check();
      });
      const last = session.messages.at(-1);
      if (!last || last.role !== 'assistant') return '(无输出)';
      return typeof last.content === 'string' ? last.content : last.content.filter(part => part.type === 'text').map(part => part.text).join('');
    } finally { clearTimeout(timer); unsubscribe(); }
  }

  enableSchedules() {
    this.schedulesEnabled = true;
    for (const workspace of this.state.workspaces) {
      try { this.cron(workspace.id, captureConfig(this.options.configDir || workspace.path, workspace.path).values); }
      catch { console.warn(`目录 ${workspace.path} 的定时任务未启动，请检查目录配置`); }
    }
  }

  private cron(workspaceId: string, config: CheeseAgentConfig) {
    if (!config.cron.enabled) return;
    const existing = this.crons.get(workspaceId);
    if (existing) return existing;
    const owner = this.cronDirectories.get(config.cron.dataDir);
    if (owner && owner !== workspaceId) throw new RuntimeError('Cron 数据目录已绑定其他工作目录，请在目录配置中指定独立 cron.dataDir');
    const service = new CronService(config.cron.dataDir);
    service.load();
    service.setExecutor({ runAgentPrompt: (prompt, timeout) => this.runPrompt(workspaceId, prompt, undefined, timeout) });
    this.crons.set(workspaceId, service);
    this.cronDirectories.set(config.cron.dataDir, workspaceId);
    if (this.schedulesEnabled) service.start();
    return service;
  }

  async manageCron(workspaceId: string, input: any, config?: CheeseAgentConfig) {
    if (this.closing) throw new RuntimeError('服务正在关闭', 503);
    const workspace = this.workspace(workspaceId);
    const service = this.cron(workspaceId, config || captureConfig(this.options.configDir || workspace.path, workspace.path).values);
    if (!service) throw new RuntimeError('当前会话未启用定时任务');
    if (input?.action === 'run') {
      if (!service.list().some(item => item.config.id === input.id)) throw new RuntimeError('定时任务不存在', 404);
      void service.runNow(input.id).catch(error => console.error('定时任务失败', error));
      return '已提交定时任务，结果请查看执行记录';
    }
    return createCronTool(service).execute(input);
  }

  submit(sessionId: string, text: string, key: string) {
    if (this.closing) throw new RuntimeError('服务正在关闭', 503);
    if (this.storageError) throw this.storageError;
    const session = this.session(sessionId);
    if (typeof text !== 'string' || !text.trim() || typeof key !== 'string' || !key) throw new RuntimeError('消息和请求标识不能为空');
    const duplicate = this.state.runs.find(run => run.sessionId === sessionId && run.key === key);
    if (duplicate) {
      if (duplicate.input && duplicate.input !== text) throw new RuntimeError('同一请求标识不能用于不同消息', 409);
      return duplicate;
    }
    if (this.state.runs.some(run => run.sessionId === sessionId && ['queued', 'running', 'stopping'].includes(run.status))) throw new RuntimeError('当前会话已有待完成任务', 409);
    const workspace = this.workspace(session.workspaceId);
    if (!this.available(workspace)) throw new RuntimeError('工作目录已不可用');
    const run: Run = { id: randomUUID(), sessionId, key, status: 'queued', input: text, messageOffset: session.messages.length + 1 };
    session.messages.push({ role: 'user', content: text });
    if (session.title === '新会话') session.title = text.slice(0, 50);
    session.updatedAt = new Date().toISOString();
    this.state.runs.push(run);
    this.emit(run, { type: 'status', status: run.status });
    this.pump();
    return run;
  }

  status() {
    return { status: this.storageError ? 'storage-error' : 'ready', active: this.jobs.size, limit: this.options.maxConcurrent ?? 3, queued: this.state.runs.filter(run => run.status === 'queued').length, children: { active: this.children.active, limit: this.children.limit } };
  }

  private pump() {
    if (this.storageError || this.closing) return;
    while (this.jobs.size < (this.options.maxConcurrent ?? 3)) {
      const run = this.state.runs.find(item => item.status === 'queued');
      if (!run) break;
      run.status = 'running';
      this.emit(run, { type: 'status', status: run.status });
      const session = this.session(run.sessionId);
      const job = this.execute(run, session, this.workspace(session.workspaceId));
      this.jobs.add(job);
      void job.finally(() => { this.jobs.delete(job); this.pump(); }).catch(() => {});
    }
  }

  private async execute(run: Run, session: Session, workspace: Workspace) {
    let secrets: string[] = [];
    let stream: ReturnType<typeof redactStream> | undefined;
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    try {
      const config = session.config ? resolveConfig(session.config) : undefined;
      secrets = collectSecrets(config);
      stream = redactStream(secrets, event => this.emit(run, { ...event, ...(event.childRunId ? { rootRunId: run.id, parentRunId: run.id } : {}) }, secrets));
      session.messages = redact(await this.executor({ cwd: workspace.path, messages: structuredClone(session.messages), config, emit: event => stream!.push(event), acquireChild: () => this.children.acquire(controller.signal), manageCron: input => { controller.signal.throwIfAborted(); return this.manageCron(workspace.id, input, config); }, signal: controller.signal }), secrets);
      run.status = controller.signal.aborted ? 'cancelled' : 'completed';
    } catch (error) {
      run.status = controller.signal.aborted ? 'cancelled' : 'failed';
      run.error = redact(error instanceof Error ? error.message : String(error), secrets);
    }
    session.updatedAt = new Date().toISOString();
    this.controllers.delete(run.id);
    stream?.flush();
    if (run.status !== 'completed') this.preservePartial(run);
    const children = new Map<string, ExecutionEvent>();
    this.events(run.id).filter(event => event.type === 'child-status').forEach(event => children.set(String(event.childRunId), event));
    for (const [childRunId, event] of children) if (['queued', 'running', 'stopping'].includes(String(event.status))) this.emit(run, { type: 'child-status', childRunId, rootRunId: run.id, parentRunId: run.id, status: controller.signal.aborted ? 'cancelled' : 'error' });
    this.emit(run, { type: 'status', status: run.status, error: run.error });
  }

  stop(id: string) {
    const run = this.state.runs.find(item => item.id === id);
    if (!run) throw new RuntimeError('任务不存在', 404);
    if (run.status === 'queued') {
      run.status = 'cancelled';
      this.emit(run, { type: 'status', status: run.status });
    } else if (run.status === 'running') {
      run.status = 'stopping';
      this.emit(run, { type: 'status', status: run.status });
      this.controllers.get(id)?.abort(new Error('用户停止了任务'));
    }
    return run;
  }

  private preservePartial(run: Run) {
    const session = this.session(run.sessionId);
    if (run.messageOffset !== undefined && session.messages.length > run.messageOffset) return;
    const text = partialText(this.events(run.id));
    if (text) session.messages.push({ role: 'assistant', content: `[未完成的输出，工具操作不会自动重放]\n${text}` });
  }

  async close() {
    this.closing = true;
    this.crons.forEach(service => service.stop());
    if (this.storageError) {
      this.controllers.forEach(controller => controller.abort(this.storageError));
      await Promise.allSettled(this.jobs);
      throw this.storageError;
    }
    const unfinished = this.state.runs.filter(run => ['queued', 'running', 'stopping'].includes(run.status));
    this.state.runs.forEach(run => this.stop(run.id));
    await this.idle();
    for (const run of unfinished) {
      run.status = 'interrupted'; run.error = '服务关闭，任务已中断';
      this.emit(run, { type: 'status', status: run.status, error: run.error });
    }
  }

  async idle() { while (this.jobs.size) await Promise.all(this.jobs); }
}
