import fs from 'node:fs';
import path from 'node:path';

/**
 * Skill（技能）的数据结构定义
 */
export interface SkillDefinition {
  /** 技能唯一名称，即 .skills/ 下的子目录名（例如: 'code-review'） */
  name: string;
  /** 技能功能描述（从 frontmatter 的 description 字段解析而来） */
  description: string;
  /** 推荐触发时机/适用场景（从 frontmatter 的 when_to_use 解析而来） */
  whenToUse?: string;
  /** 技能的 Prompt 指令内容（去除 Frontmatter 后的 Markdown 正文） */
  content: string;
  /** 该技能所在的物理目录绝对/相对路径 */
  dirPath: string;
}

/** 默认存放 Skills 的根目录名 */
const SKILLS_DIR = '.skills';
/** 约定的技能定义文件名 */
const SKILL_FILE = 'SKILL.md';

/**
 * 技能加载与 Prompt 组装器。
 *
 * 核心设计定位：
 * - “插件（Plugin）”是纯代码层的能力扩展（为 Agent 注册新的 Tool 工具/函数）；
 * - “技能（Skill）”则是**基于 Prompt 工程的领域 SOP 流程封装**。
 *   它不需要写复杂的 TypeScript 代码，只需在 `.skills/<name>/SKILL.md` 中以 Markdown 形式定义
 *   工作流规范、审查标准或特定任务的思考步骤。
 */
export class SkillLoader {
  /** 扫描的基础工作目录 */
  private readonly baseDir: string;
  /** 内存中缓存的已解析技能映射（Key 为 skill 名称） */
  private skills = new Map<string, SkillDefinition>();

  constructor(baseDir = '.') {
    this.baseDir = baseDir;
  }

  /** 计算 .skills 根目录路径 */
  private get skillsDir(): string {
    return path.join(this.baseDir, SKILLS_DIR);
  }

  /**
   * 遍历扫描 `.skills/` 目录并解析所有合法的技能定义文件。
   *
   * 目录结构约定：
   * .skills/
   * └── code-review/
   *     └── SKILL.md  (包含 YAML Frontmatter 元信息 + Markdown SOP 流程)
   */
  load(): SkillDefinition[] {
    this.skills.clear();
    if (!fs.existsSync(this.skillsDir)) return [];

    const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(this.skillsDir, entry.name, SKILL_FILE);
      if (!fs.existsSync(skillFile)) continue;

      const raw = fs.readFileSync(skillFile, 'utf-8');
      const parsed = this.parseFrontmatter(raw);
      if (!parsed) continue;

      const skill: SkillDefinition = {
        name: entry.name,
        description: parsed.description,
        whenToUse: parsed.whenToUse,
        content: parsed.content,
        dirPath: path.join(this.skillsDir, entry.name),
      };
      this.skills.set(skill.name, skill);
    }

    return this.list();
  }

  /**
   * 列出所有扫描到的可用技能
   */
  list(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  /**
   * 根据名称获取特定技能定义
   */
  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  /**
   * 动态构建并拼接系统 Prompt（System Prompt Injection）。
   *
   * 运行机制：
   * 1. 如果有已被用户显式激活的技能（在 activeSkills 集合中），将其完整的 Markdown SOP 正文直接注入系统提示词；
   * 2. 对于尚未激活但可用的技能，在末尾附带一份轻量的清单列表（名称 + 简述 + 适用时机），提醒 LLM 或用户可以通过 `/skill load <name>` 激活。
   *
   * @param activeSkills 当前会话中已激活的技能名称集合
   */
  buildPromptSection(activeSkills: Set<string>): string | null {
    if (this.skills.size === 0) return null;

    const lines: string[] = [];

    // --- 1. 注入已激活技能的完整 SOP 指引 ---
    if (activeSkills.size > 0) {
      for (const name of activeSkills) {
        const skill = this.skills.get(name);
        if (!skill) continue;
        lines.push(`[激活的 Skill: ${skill.name}]`);
        lines.push(skill.content);
        lines.push('');
      }
    }

    // --- 2. 展示未激活的可用技能目录索引 ---
    const available = this.list()
      .filter((s) => !activeSkills.has(s.name))
      .map((s) => {
        const hint = s.whenToUse ? ` (适用场景: ${s.whenToUse})` : '';
        return `  /${s.name} — ${s.description}${hint}`;
      });

    if (available.length > 0) {
      lines.push('可用的 Skills（输入 /skill load <name> 激活）：');
      lines.push(...available);
    }

    return lines.length > 0 ? lines.join('\n') : null;
  }

  /**
   * 简单的轻量级 YAML Frontmatter 解析器。
   * 负责提取文件头部的 `---` 区域内的元数据（description, when_to_use 等）并分离 Markdown 正文。
   */
  private parseFrontmatter(raw: string): { description: string; whenToUse?: string; content: string } | null {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return { description: '', content: raw };

    const meta: Record<string, string> = {};
    for (const line of match[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        const key = line.slice(0, idx).trim();
        let value = line.slice(idx + 1).trim();
        // 去除字符串前后的双引号或单引号
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        meta[key] = value;
      }
    }

    return {
      description: meta.description || '',
      whenToUse: meta.when_to_use || undefined,
      content: match[2].trim(),
    };
  }
}
