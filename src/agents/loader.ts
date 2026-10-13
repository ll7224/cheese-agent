import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { AgentManifestSchema, type AgentDefinition } from './manifest.js';
export type { AgentDefinition };

/** 默认存放 Agents 的根目录名 */
export const AGENTS_DIR = '.agents';
/** 约定的 Agent 清单定义文件名 */
export const AGENT_FILE = 'agent.json';

/**
 * 系统内置的通用助手（General Assistant）
 * 作为一切未指定 AgentId 或历史会话的基准与兜底。拥有全量工具权限和开箱即用能力。
 */
export const BUILTIN_GENERAL_AGENT: AgentDefinition = {
  id: 'general',
  name: '通用助手',
  description: '全能通用智能助手，开箱即用，支持日常问答、代码分析、网络探索与多任务处理。',
  avatar: '🧀',
  systemPrompt: '',
  fullPrompt: '',
  tools: ['*'], // 通配符：通用助手拥有所有已注册工具权限
  skills: [],
  knowledge: [],
  maxSteps: 30,
  dirPath: 'builtin',
  source: 'builtin',
};

/**
 * 垂直领域 Agent 加载器（AgentLoader）。
 *
 * 核心架构特色：
 * 1. 双层目录扫描（Dual-Directory Scanning）：自动扫描全局目录（~/.cheese/agents/）与工作区目录（<workspace>/.agents/）；
 * 2. 同名优先覆盖（Workspace Precedence）：工作区局部 Agent 优先覆盖同名全局 Agent；
 * 3. 资产解耦与自动关联：支持从外部 PROMPT.md 加载长提示词，自动关联领域 docs/ 目录；
 * 4. 内置平滑兜底：始终内置 'general' 通用助手，杜绝空状态与未命中崩溃。
 */
export class AgentLoader {
  /** 扫描的基础工作目录 */
  private readonly baseDir: string;
  /** 全局 Agent 扫描目录，默认 ~/.cheese/agents */
  private readonly globalAgentsDir: string;
  /** 内存中缓存的已解析 Agent 映射（Key 为 agentId） */
  private agents = new Map<string, AgentDefinition>();

  constructor(baseDir = '.', globalAgentsDir?: string) {
    this.baseDir = baseDir;
    this.globalAgentsDir = globalAgentsDir ?? path.join(homedir(), '.cheese', 'agents');
  }

  /** 计算工作区 .agents 根目录路径 */
  private get workspaceAgentsDir(): string {
    return path.join(this.baseDir, AGENTS_DIR);
  }

  /**
   * 遍历扫描全局与工作区目录，解析并缓存所有合法的 Agent 资产包。
   *
   * @returns 排序后的 Agent 列表（general 始终排首位）
   */
  load(): AgentDefinition[] {
    this.agents.clear();

    // 1. 始终先注入内置的通用助手
    this.agents.set(BUILTIN_GENERAL_AGENT.id, { ...BUILTIN_GENERAL_AGENT });

    // 2. 扫描全局 Agent 目录 (~/.cheese/agents/)
    this.scanDirectory(this.globalAgentsDir, 'global');

    // 3. 扫描工作区局部 Agent 目录 (.agents/)，同名优先覆盖
    this.scanDirectory(this.workspaceAgentsDir, 'workspace');

    return this.list();
  }

  /**
   * 扫描指定目录下的 Agent 子文件夹
   */
  private scanDirectory(dir: string, source: 'workspace' | 'global'): void {
    if (!fs.existsSync(dir)) return;

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const agentDir = path.join(dir, entry.name);
      const manifestPath = path.join(agentDir, AGENT_FILE);

      if (!fs.existsSync(manifestPath)) continue;

      try {
        const raw = fs.readFileSync(manifestPath, 'utf-8');
        const parsedJson = JSON.parse(raw);
        // 若 JSON 中未显式填写 id，自动将文件夹名称作为其 ID
        if (!parsedJson.id) {
          parsedJson.id = entry.name;
        }

        const parsed = AgentManifestSchema.safeParse(parsedJson);
        if (!parsed.success) {
          console.warn(`[AgentLoader] 忽略格式非法的 Agent (${manifestPath}):`, parsed.error.issues);
          continue;
        }

        const manifest = parsed.data;

        // 加载或拼接完整 System Prompt
        let fullPrompt = manifest.systemPrompt || '';
        if (manifest.promptFile) {
          const promptFilePath = path.join(agentDir, manifest.promptFile);
          if (fs.existsSync(promptFilePath)) {
            const externalPrompt = fs.readFileSync(promptFilePath, 'utf-8').trim();
            fullPrompt = fullPrompt ? `${fullPrompt}\n\n${externalPrompt}` : externalPrompt;
          }
        }

        // 自动发现包内 docs/ 目录：若存在 docs/ 且未显式指定，将其作为默认关联 collection
        const docsDir = path.join(agentDir, 'docs');
        const knowledge = [...manifest.knowledge];
        if (fs.existsSync(docsDir) && !knowledge.includes(manifest.id)) {
          knowledge.push(manifest.id);
        }

        const def: AgentDefinition = {
          ...manifest,
          knowledge,
          fullPrompt,
          dirPath: agentDir,
          source,
        };

        this.agents.set(def.id, def);
      } catch (err: any) {
        console.warn(`[AgentLoader] 解析 Agent 资产包失败 (${manifestPath}):`, err?.message);
      }
    }
  }

  /**
   * 获取指定 ID 的 Agent 定义。
   * 若不存在则安全回退到内置的 general 通用助手。
   */
  get(id?: string): AgentDefinition {
    if (!id) return this.agents.get(BUILTIN_GENERAL_AGENT.id) || BUILTIN_GENERAL_AGENT;
    return this.agents.get(id) || BUILTIN_GENERAL_AGENT;
  }

  /**
   * 判断是否存在指定 ID 的 Agent
   */
  has(id: string): boolean {
    return this.agents.has(id);
  }

  /**
   * 列出所有已加载的 Agent 列表（保证 general 始终排在第一位）
   */
  list(): AgentDefinition[] {
    const all = Array.from(this.agents.values());
    const general = all.find((a) => a.id === BUILTIN_GENERAL_AGENT.id);
    const others = all.filter((a) => a.id !== BUILTIN_GENERAL_AGENT.id);
    return general ? [general, ...others] : others;
  }
}
