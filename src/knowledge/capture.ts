import { randomUUID } from 'node:crypto';
import type { ModelMessage } from 'ai';
import type { ExecutionEvent } from '../runtime/events.js';
import type { KnowledgeContext, KnowledgeItem, KnowledgeStatus } from './types.js';
import type { KnowledgeStore } from './store.js';
import { saveExecutionEvidence } from './evidence.js';

export interface CaptureInput {
  runId: string;
  sessionId: string;
  workspaceId: string;
  userInput: string;
  messages: ModelMessage[];
  events: ExecutionEvent[];
  environment: {
    cwd: string;
    commit?: string;
    runtimeVersion: string;
    modelName?: string;
  };
}

/**
 * 规则与候选沉淀条目提取器
 */
export async function extractKnowledgeItems(
  store: KnowledgeStore,
  ctx: KnowledgeContext,
  input: CaptureInput,
  signal?: AbortSignal
): Promise<KnowledgeItem[]> {
  const items: KnowledgeItem[] = [];
  const targetLibraryId = `project:${ctx.workspaceId}`;
  const now = Date.now();

  // 1. 处理工具执行证据 (execution-evidence)
  for (const event of input.events || []) {
    if (signal?.aborted) break;
    if (event.type === 'execution-evidence') {
      const cmdEvidence = {
        executionId: String(event.executionId || event.id || randomUUID()),
        command: String(event.command || ''),
        cwd: String(event.cwd || input.environment?.cwd || process.cwd()),
        exitCode: typeof event.exitCode === 'number' ? event.exitCode : null,
        timedOut: Boolean(event.timedOut),
        stdout: String(event.stdout || ''),
        stderr: String(event.stderr || ''),
        timestamp: String(event.timestamp || new Date().toISOString()),
      };

      // 存储不可变执行证据快照
      saveExecutionEvidence(store.db, input.runId, cmdEvidence);

      // 规则：命令 exitCode === 0 且无超时，生效为该环境的本次执行观察
      // 超时/返回错误文本/非零状态码绝不生效为 effective
      if (cmdEvidence.exitCode === 0 && !cmdEvidence.timedOut) {
        items.push({
          id: `item-obs-${cmdEvidence.executionId}`,
          kind: 'observation',
          status: 'effective',
          text: `在环境 ${cmdEvidence.cwd} 下执行命令 \`${cmdEvidence.command}\` 成功 (exit 0)`,
          libraryId: targetLibraryId,
          evidenceIds: [cmdEvidence.executionId],
          applicability: cmdEvidence.cwd, // 严格保持环境范围
          originRunId: input.runId,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }

  // 2. 处理用户显式决定与歧义建议
  const rawInput = (input.userInput || '').trim();
  if (rawInput) {
    // 显式决定关键字
    const hasDecisionKeyword = /(?:决定|确认|统一|选择|选定|采用|规定|约定|\b(?:decide|decision|agreed|choose)\b)/i.test(rawInput);
    // 疑问/歧义/建议成分
    const isAmbiguous = /[?？]|(?:建议|推荐|可能|或许|考虑|是否|能否|可以吗|怎么样|如何|怎样|\b(?:maybe|suggest|recommend)\b)/i.test(rawInput);

    if (hasDecisionKeyword && !isAmbiguous) {
      // 用户原话明确映射生效为 decision
      items.push({
        id: `item-dec-${randomUUID()}`,
        kind: 'decision',
        status: 'effective',
        text: rawInput,
        libraryId: targetLibraryId,
        evidenceIds: [input.runId],
        applicability: 'project',
        originRunId: input.runId,
        createdAt: now,
        updatedAt: now,
      });
    } else if (isAmbiguous || /(?:建议|推荐|考虑|经验|实践)/i.test(rawInput)) {
      // 歧义推荐保持为 candidate experience
      items.push({
        id: `item-exp-${randomUUID()}`,
        kind: 'experience',
        status: 'candidate',
        text: rawInput,
        libraryId: targetLibraryId,
        evidenceIds: [input.runId],
        applicability: 'project',
        originRunId: input.runId,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  // 3. 处理模型输出与助手消息
  // 规则：reasoning 不参加提取；模型自证链拒绝成为核验依据
  for (const msg of input.messages || []) {
    if (signal?.aborted) break;
    if (msg.role !== 'assistant') continue;

    let contentText = '';
    if (typeof msg.content === 'string') {
      contentText = msg.content;
    } else if (Array.isArray(msg.content)) {
      contentText = msg.content
        .filter((part: any) => part.type === 'text')
        .map((part: any) => part.text)
        .join('\n');
    }

    // 过滤模型自证链语句（如“经测试代码完全正确”、“我已经全面验证”等不可作为有效事实依据）
    const lines = contentText.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // 提取助手中的建议或最佳实践，统一为 candidate experience
      const expMatch = trimmed.match(/^(?:建议|推荐|最佳实践|经验总结|注意)[:：\s](.+)$/i);
      if (expMatch && expMatch[1]) {
        // 自证链过滤
        const isSelfClaim = /(?:经测试|我已经|已经全面验证|绝对可靠|完全正确|self-verified)/i.test(trimmed);
        if (!isSelfClaim) {
          items.push({
            id: `item-exp-${randomUUID()}`,
            kind: 'experience',
            status: 'candidate',
            text: expMatch[1].trim(),
            libraryId: targetLibraryId,
            evidenceIds: [input.runId],
            applicability: 'project',
            originRunId: input.runId,
            createdAt: now,
            updatedAt: now,
          });
        }
      }
    }
  }

  return items;
}

/**
 * 异步沉淀任务执行队列 (默认容量 20)
 */
export class CaptureQueue {
  private queue: Array<{
    ctx: KnowledgeContext;
    input: CaptureInput;
    resolve?: () => void;
    reject?: (err: any) => void;
  }> = [];
  private activeCount: number = 0;
  private readonly capacity: number = 20;
  private readonly activeControllers = new Set<AbortController>();
  private closed: boolean = false;
  private readonly waitResolvers = new Map<string, Array<() => void>>();

  constructor(
    private readonly store: KnowledgeStore,
    options: {
      capacity?: number;
      modelForWorkspace?: (workspaceId: string) => any;
    } = {}
  ) {
    if (options.capacity) {
      this.capacity = options.capacity;
    }
  }

  /**
   * 将提取任务排入队列（非阻塞、去重）
   */
  enqueue(ctx: KnowledgeContext, input: CaptureInput): void {
    if (this.closed) return;

    // 1. 同 runId 去重
    const existingJob = this.store.getCaptureJob(input.runId);
    if (existingJob) {
      return;
    }

    // 2. 插入 pending 作业记录
    const jobId = `job-${input.runId}`;
    this.store.createCaptureJob({
      id: jobId,
      runId: input.runId,
      status: 'pending',
      createdAt: Date.now(),
    });

    this.queue.push({ ctx, input });
    this.pump();
  }

  /**
   * 触发执行队列
   */
  private pump(): void {
    if (this.closed) return;

    while (this.activeCount < this.capacity && this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) break;

      this.activeCount++;
      const controller = new AbortController();
      this.activeControllers.add(controller);

      void this.processTask(task.ctx, task.input, controller.signal)
        .finally(() => {
          this.activeControllers.delete(controller);
          this.activeCount--;
          this.notifyDone(task.input.runId);
          this.pump();
        })
        .catch(() => {});
    }
  }

  /**
   * 执行单次沉淀任务
   */
  private async processTask(
    ctx: KnowledgeContext,
    input: CaptureInput,
    signal: AbortSignal
  ): Promise<void> {
    this.store.updateCaptureJob(input.runId, 'running');

    try {
      const items = await extractKnowledgeItems(this.store, ctx, input, signal);

      // 单事务写入知识条目并更新作业为完成
      const tx = this.store.db.transaction(() => {
        for (const item of items) {
          this.store.createKnowledgeItem(item);
        }
        this.store.updateCaptureJob(input.runId, 'completed');
      });
      tx();
    } catch (err: any) {
      this.store.updateCaptureJob(input.runId, 'failed', err?.message || String(err));
    }
  }

  private notifyDone(runId: string): void {
    const list = this.waitResolvers.get(runId);
    if (list) {
      this.waitResolvers.delete(runId);
      for (const fn of list) fn();
    }
  }

  /**
   * 等待指定 runId 的作业完成（主要用于测试等待）
   */
  async waitForRun(runId: string, timeoutMs: number = 5000): Promise<void> {
    const job = this.store.getCaptureJob(runId);
    if (job && (job.status === 'completed' || job.status === 'failed')) {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for capture runId: ${runId}`));
      }, timeoutMs);

      const list = this.waitResolvers.get(runId) || [];
      list.push(() => {
        clearTimeout(timer);
        resolve();
      });
      this.waitResolvers.set(runId, list);
    });
  }

  /**
   * 关闭队列并取消正在进行的提取请求
   */
  close(): void {
    this.closed = true;
    for (const controller of this.activeControllers) {
      controller.abort();
    }
    this.activeControllers.clear();
    this.queue = [];
  }
}
