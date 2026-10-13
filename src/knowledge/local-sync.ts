import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import chokidar, { type FSWatcher } from 'chokidar';
import fg from 'fast-glob';
import type { KnowledgeStore } from './store.js';
import type { Source, RevisionDraft, CodeIndex } from './types.js';
import { chunkWithSpans } from './chunks.js';
import { isIgnoredKnowledgePath, IGNORE_PATTERNS, MAX_FILE_SIZE_BYTES } from './sources.js';
import { indexCode } from './code-indexer.js';

export { isIgnoredKnowledgePath };

export type EmbeddingFn = (texts: string[]) => Promise<number[][]>;

export interface LocalSyncOptions {
  debounceMs?: number;
  embedder?: EmbeddingFn;
}

interface PendingEvent {
  sourceId: string;
  filePath: string;
  event: 'add' | 'change' | 'unlink';
  workspacePath: string;
}

/**
 * 负责本地知识源的增量监听、去抖队列与受管发布。
 * 遵循严格安全沙箱：realpath 校验、符号链接不跟随、1 MiB 文件上限、忽略凭据与中间目录。
 */
export class LocalSyncManager {
  private readonly store: KnowledgeStore;
  private readonly embedder?: EmbeddingFn;
  private readonly debounceMs: number;

  private watchers = new Map<string, FSWatcher>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private pendingEvents = new Map<string, PendingEvent>();
  private sourceQueues = new Map<string, Promise<void>>();
  private isClosing = false;

  constructor(store: KnowledgeStore, options: LocalSyncOptions = {}) {
    this.store = store;
    this.embedder = options.embedder;
    this.debounceMs = options.debounceMs ?? 500;
  }

  /**
   * 启动对指定本地来源的目录或文件监听
   */
  async startWatch(source: Source, workspacePath: string): Promise<void> {
    if (this.isClosing) return;
    if (source.kind !== 'local') return;

    // 已在监听则先关闭
    await this.stopWatch(source.id);

    const realWorkspace = fs.realpathSync(workspacePath);
    const targetPath = path.resolve(workspacePath, source.locator);

    if (!fs.existsSync(targetPath)) {
      return;
    }

    const realTarget = fs.realpathSync(targetPath);
    if (!realTarget.startsWith(realWorkspace)) {
      throw new Error(`Source realpath escapes workspace boundary: ${source.locator}`);
    }

    const watcher = chokidar.watch(targetPath, {
      ignoreInitial: true,
      followSymlinks: false,
      ignored: (testPath: string) => isIgnoredKnowledgePath(testPath),
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });

    watcher.on('all', (event, changedPath) => {
      if (event === 'add' || event === 'change' || event === 'unlink') {
        this.queueSourceChange(source.id, changedPath, event, realWorkspace);
      }
    });

    watcher.on('error', (err: any) => {
      this.store.updateSource(source.id, {
        syncStatus: 'error',
        lastError: err?.message || 'Watcher error',
      });
    });

    this.watchers.set(source.id, watcher);

    await new Promise<void>((resolve) => {
      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };
      watcher.on('ready', done);
      setTimeout(done, 500);
    });
  }

  /**
   * 停止指定来源的监听
   */
  async stopWatch(sourceId: string): Promise<void> {
    const watcher = this.watchers.get(sourceId);
    if (watcher) {
      this.watchers.delete(sourceId);
      await watcher.close();
    }
  }

  /**
   * 事件统一排队进入 500ms 去抖机制，合并同一文件最新的变更状态
   */
  queueSourceChange(
    sourceId: string,
    filePath: string,
    event: 'add' | 'change' | 'unlink',
    workspacePath: string
  ): void {
    if (this.isClosing) return;

    const key = `${sourceId}::${filePath}`;
    const existingTimer = this.debounceTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    this.pendingEvents.set(key, {
      sourceId,
      filePath,
      event,
      workspacePath,
    });

    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      const item = this.pendingEvents.get(key);
      this.pendingEvents.delete(key);
      if (item) {
        this.enqueueProcess(item);
      }
    }, this.debounceMs);

    this.debounceTimers.set(key, timer);
  }

  /**
   * 按来源串行排队执行具体发布处理
   */
  private enqueueProcess(item: PendingEvent): void {
    let currentQueue = this.sourceQueues.get(item.sourceId) || Promise.resolve();
    currentQueue = currentQueue
      .then(async () => {
        try {
          await this.processSourceChange(
            item.sourceId,
            item.filePath,
            item.event,
            item.workspacePath
          );
        } catch (err: any) {
          this.store.updateSource(item.sourceId, {
            syncStatus: 'error',
            lastError: err?.message || 'Sync error',
          });
        }
      })
      .catch(() => {});

    this.sourceQueues.set(item.sourceId, currentQueue);
  }

  /**
   * 处理单个文件的变更或删除
   */
  async processSourceChange(
    sourceId: string,
    filePath: string,
    event: 'add' | 'change' | 'unlink',
    workspacePath: string
  ): Promise<void> {
    const source = this.store.getSource(sourceId);
    if (!source || !source.enabled) return;

    const realWorkspace = fs.realpathSync(workspacePath);
    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(realWorkspace, filePath);

    let safePath = absPath;
    try {
      if (fs.existsSync(absPath)) {
        safePath = fs.realpathSync(absPath);
      }
    } catch {}

    let relKey = path.relative(realWorkspace, safePath).replace(/\\/g, '/');
    if (relKey.startsWith('..')) {
      if (realWorkspace.startsWith('/private') && !safePath.startsWith('/private')) {
        relKey = path.relative(realWorkspace, '/private' + safePath).replace(/\\/g, '/');
      } else if (!realWorkspace.startsWith('/private') && safePath.startsWith('/private')) {
        relKey = path.relative('/private' + realWorkspace, safePath).replace(/\\/g, '/');
      }
    }

    // 路径安全及忽略检查
    if (relKey.startsWith('..') || isIgnoredKnowledgePath(relKey) || isIgnoredKnowledgePath(absPath)) {
      return;
    }

    if (event === 'unlink') {
      const doc = this.store.getDocument(sourceId, relKey);
      if (doc) {
        this.store.deleteDocument(doc.id);
      }
      this.store.updateSource(sourceId, {
        syncStatus: 'ready',
        lastSyncAt: Date.now(),
        lastError: undefined,
      });
      return;
    }

    // add 或 change
    if (!fs.existsSync(absPath)) {
      const doc = this.store.getDocument(sourceId, relKey);
      if (doc) {
        this.store.deleteDocument(doc.id);
      }
      return;
    }

    const stat = fs.lstatSync(absPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return;
    }

    if (stat.size > MAX_FILE_SIZE_BYTES) {
      // 超过 1 MiB 忽略
      return;
    }

    const content = fs.readFileSync(absPath, 'utf-8');
    const hash = crypto.createHash('sha256').update(content).digest('hex');

    // 检查历史 hash 是否相同：未变化则跳过 embedding 与发布
    const existingDoc = this.store.getDocument(sourceId, relKey);
    if (existingDoc?.activeRevisionId) {
      const oldRev = this.store.readRevision(existingDoc.activeRevisionId);
      if (oldRev && oldRev.hash === hash) {
        return;
      }
    }

    // 切分分块
    const rawChunks = chunkWithSpans(content);
    let chunkEmbeddings: number[][] | undefined;

    if (this.embedder && rawChunks.length > 0) {
      chunkEmbeddings = await this.embedder(rawChunks.map((c) => c.text));
    }

    // 代码结构索引（TS/JS 代码提取实体与引用边）
    let codeIndex: CodeIndex | undefined;
    const ext = path.extname(relKey).toLowerCase();
    if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
      const lib = this.store.getLibrary(source.libraryId);
      const wsId = lib?.workspaceId || '';
      codeIndex = indexCode(wsId, relKey, content, realWorkspace);
    }

    const draft: RevisionDraft = {
      sourceId,
      sourceKey: relKey,
      content,
      hash,
      expectedPreviousRevisionId: existingDoc?.activeRevisionId || null,
      chunks: rawChunks.map((c, idx) => ({
        text: c.text,
        span: c.span,
        embedding: chunkEmbeddings ? chunkEmbeddings[idx] : undefined,
        evidenceKind: codeIndex ? 'code' : 'document',
      })),
      codeIndex,
    };

    this.store.publishRevision(draft);
    this.store.updateSource(sourceId, {
      syncStatus: 'ready',
      lastSyncAt: Date.now(),
      lastError: undefined,
    });
  }

  /**
   * 手动或全量扫描同步指定来源
   */
  async syncSource(source: Source, workspacePath: string): Promise<void> {
    if (source.kind !== 'local') return;

    this.store.updateSource(source.id, { syncStatus: 'syncing' });

    try {
      const realWorkspace = fs.realpathSync(workspacePath);
      const targetPath = path.resolve(realWorkspace, source.locator);

      if (!targetPath.startsWith(realWorkspace)) {
        throw new Error(`Target path escapes workspace boundary: ${source.locator}`);
      }

      if (!fs.existsSync(targetPath)) {
        this.store.updateSource(source.id, {
          syncStatus: 'ready',
          lastSyncAt: Date.now(),
          lastError: undefined,
        });
        return;
      }

      const realTarget = fs.realpathSync(targetPath);
      if (!realTarget.startsWith(realWorkspace)) {
        throw new Error(`Real target escapes workspace boundary: ${source.locator}`);
      }

      const stat = fs.lstatSync(realTarget);
      const activeDiskRelKeys = new Set<string>();

      if (stat.isFile()) {
        const rel = path.relative(realWorkspace, realTarget).replace(/\\/g, '/');
        if (!isIgnoredKnowledgePath(rel) && stat.size <= MAX_FILE_SIZE_BYTES) {
          activeDiskRelKeys.add(rel);
          await this.processSourceChange(source.id, realTarget, 'add', realWorkspace);
        }
      } else if (stat.isDirectory()) {
        const entries = await fg('**/*', {
          cwd: realTarget,
          onlyFiles: true,
          followSymbolicLinks: false,
          ignore: IGNORE_PATTERNS,
        });

        for (const entry of entries) {
          if (isIgnoredKnowledgePath(entry)) continue;
          const fullPath = path.join(realTarget, entry);
          try {
            const entryStat = fs.lstatSync(fullPath);
            if (entryStat.isSymbolicLink() || !entryStat.isFile()) continue;
            if (entryStat.size > MAX_FILE_SIZE_BYTES) continue;

            const relKey = path.relative(realWorkspace, fullPath).replace(/\\/g, '/');
            activeDiskRelKeys.add(relKey);
            await this.processSourceChange(source.id, fullPath, 'add', realWorkspace);
          } catch {}
        }
      }

      // 清理已在磁盘上被删除的文件
      const existingDocs = this.store.listDocuments(source.id);
      for (const doc of existingDocs) {
        if (!activeDiskRelKeys.has(doc.sourceKey)) {
          this.store.deleteDocument(doc.id);
        }
      }

      this.store.updateSource(source.id, {
        syncStatus: 'ready',
        lastSyncAt: Date.now(),
        lastError: undefined,
      });
    } catch (err: any) {
      this.store.updateSource(source.id, {
        syncStatus: 'error',
        lastError: err?.message || 'Sync failed',
      });
      throw err;
    }
  }

  /**
   * 等待所有去抖计时器和排队中的同步处理完毕
   */
  async waitForIdle(): Promise<void> {
    // 触发所有未到期的计时器立刻入队
    for (const [key, timer] of Array.from(this.debounceTimers.entries())) {
      clearTimeout(timer);
      this.debounceTimers.delete(key);
      const item = this.pendingEvents.get(key);
      this.pendingEvents.delete(key);
      if (item) {
        this.enqueueProcess(item);
      }
    }

    // 等待所有 sourceQueue 执行完成
    const queues = Array.from(this.sourceQueues.values());
    await Promise.all(queues);
  }

  /**
   * 关闭所有 watcher 并等待队列收敛
   */
  async close(): Promise<void> {
    this.isClosing = true;

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.pendingEvents.clear();

    const watcherClosures = Array.from(this.watchers.values()).map((w) => w.close());
    this.watchers.clear();
    await Promise.all(watcherClosures);

    const queues = Array.from(this.sourceQueues.values());
    await Promise.all(queues);
    this.sourceQueues.clear();
  }
}
