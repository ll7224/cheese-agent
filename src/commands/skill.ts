import { type ModelMessage } from 'ai';
import { agentLoop } from '../agent/loop.js';
import type { CommandHandler } from './index.js';
import type { SkillLoader } from '../skills/loader.js';

/**
 * 创建与 Skill（技能）相关的 CLI 交互命令处理器。
 *
 * 支持的交互指令：
 * 1. `/skill` 或 `/skill list`：查看当前目录扫描出的所有可用技能及其激活状态；
 * 2. `/skill load <name>`：在当前会话中显式激活某个技能（其 SOP 会持续注入后续系统提示词中）；
 * 3. `/skill unload <name>`：卸载/反激活指定技能；
 * 4. `/<skill-name> [可选参数]`：一键快捷调用！自动激活该技能，并将技能的 Markdown SOP 作为本次对话的专属指令立即触发 Agent 循环。
 *
 * @param skillLoader 技能文件解析与加载器
 * @param activeSkills 存储当前会话中所有已激活技能名称的 Set 集合
 */
export function createSkillCommands(skillLoader: SkillLoader, activeSkills: Set<string>): CommandHandler[] {
  return [
    // ---------------------- 1. /skill list ----------------------
    (cmd, ctx) => {
      if (cmd !== '/skill' && cmd !== '/skill list' && cmd !== 'skill list') return false;
      const skills = skillLoader.list();
      if (skills.length === 0) {
        console.log('\n[skills] 没有找到任何 skill。在 .skills/ 目录下创建 skill-name/SKILL.md 即可。\n');
        return true;
      }
      console.log(`\n[skills] 共 ${skills.length} 个可用：`);
      for (const s of skills) {
        const active = activeSkills.has(s.name) ? ' ✓ 已激活' : '';
        console.log(`  /${s.name} — ${s.description}${active}`);
        if (s.whenToUse) console.log(`    适用场景: ${s.whenToUse}`);
      }
      console.log('');
      return true;
    },

    // ---------------------- 2. /skill load <name> ----------------------
    (cmd, ctx) => {
      const match = cmd.match(/^\/skill\s+load\s+(\S+)$/);
      if (!match) return false;
      const name = match[1];
      const skill = skillLoader.get(name);
      if (!skill) {
        console.log(`\n[skills] 找不到 skill: ${name}\n`);
        return true;
      }
      // 加入激活集合，后续 promptPipe 在每轮 loop 生成 system prompt 时会自动包含该 skill 的 SOP
      activeSkills.add(name);
      console.log(`\n[skills] 已激活: ${name} — ${skill.description}\n`);
      return true;
    },

    // ---------------------- 3. /skill unload <name> ----------------------
    (cmd, ctx) => {
      const match = cmd.match(/^\/skill\s+unload\s+(\S+)$/);
      if (!match) return false;
      const name = match[1];
      if (!activeSkills.has(name)) {
        console.log(`\n[skills] ${name} 未激活\n`);
        return true;
      }
      activeSkills.delete(name);
      console.log(`\n[skills] 已卸载: ${name}\n`);
      return true;
    },

    // ---------------------- 4. /<skill-name> 快捷触发执行 ----------------------
    (cmd, ctx) => {
      if (!cmd.startsWith('/')) return false;
      const parts = cmd.slice(1).split(/\s+/);
      const name = parts[0];
      const skill = skillLoader.get(name);
      // 如果不是系统收录的 skill 名称，放行给其他命令处理器（如 /help, /plugin 等）
      if (!skill) return false;

      // 自动标为已激活
      activeSkills.add(name);
      console.log(`\n[skills] 激活 ${name}，开始执行...`);

      // 构造本次用户输入：将 Skill 的完整 SOP 作为指令主体，并附加用户的补充参数
      const args = parts.slice(1).join(' ');
      const content = args
        ? `${skill.content}\n\n用户指令: ${args}`
        : skill.content;

      // 构建用户消息并存入历史记录与会话持久化存储
      const userMsg: ModelMessage = { role: 'user', content };
      ctx.messages.push(userMsg);
      ctx.timestamps.set(ctx.messages.length - 1, Date.now());
      ctx.sessionStore.append(userMsg);

      // 实时编译带有该 Skill 内容的最新 System Prompt
      const currentSystem = ctx.builder.build(ctx.makePromptCtx());
      const beforeLen = ctx.messages.length;

      // 启动 Agent 执行主循环
      agentLoop(ctx.model, ctx.registry, ctx.messages, currentSystem, ctx.tracker).then(() => {
        const newMessages = ctx.messages.slice(beforeLen);
        const now = Date.now();
        for (let i = beforeLen; i < ctx.messages.length; i++) ctx.timestamps.set(i, now);
        ctx.sessionStore.appendAll(newMessages);
        // 执行完毕后重新等待用户输入
        ctx.ask();
      });

      // 返回 'async' 告知 CLI 外层主循环：本轮由异步流程接管输入回调
      return 'async';
    },
  ];
}
