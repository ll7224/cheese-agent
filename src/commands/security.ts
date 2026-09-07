import type { CommandHandler } from './index.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { HookPipeline } from '../security/hooks.js';
import type { Role } from '../security/roles.js';

/**
 * 创建与安全与权限（Security & RBAC）相关的 CLI 控制台指令。
 *
 * 支持指令：
 * 1. `/role`：查看当前用户的角色身份以及当前角色被允许调用的工具数量；
 * 2. `/role <owner|collaborator|guest>`：动态切换当前运行时的安全角色，即时热更新可用工具集合；
 * 3. `/hooks`：列出当前 HookPipeline 中已挂载的前置（Pre-Tool）与后置（Post-Tool）拦截钩子。
 *
 * @param registry 工具注册表实例
 * @param hookPipeline 工具拦截切面管道实例
 */
export function createSecurityCommands(
  registry: ToolRegistry,
  hookPipeline: HookPipeline,
): CommandHandler[] {
  return [
    // /role [owner|collaborator|guest] 指令处理器
    (cmd, _ctx) => {
      const match = cmd.match(/^\/role(?:\s+(owner|collaborator|guest))?$/);
      if (!match) return false;

      if (match[1]) {
        // 动态变更角色
        const role = match[1] as Role;
        registry.setRole(role);
        const toolCount = registry.getActiveTools().length;
        console.log(`\n[security] 角色切换为 ${role}，可用工具: ${toolCount} 个\n`);
      } else {
        // 查询当前角色
        const role = registry.getRole();
        const toolCount = registry.getActiveTools().length;
        console.log(`\n[security] 当前角色: ${role}，可用工具: ${toolCount} 个\n`);
      }
      return true;
    },

    // /hooks 指令处理器：列出已注册的安全生命周期钩子
    (cmd, _ctx) => {
      if (cmd !== '/hooks') return false;

      const hooks = hookPipeline.list();
      console.log('\n[hooks]');
      if (hooks.pre.length > 0) {
        console.log('  Pre-Tool Hooks:');
        for (const name of hooks.pre) console.log(`    - ${name}`);
      }
      if (hooks.post.length > 0) {
        console.log('  Post-Tool Hooks:');
        for (const name of hooks.post) console.log(`    - ${name}`);
      }
      if (hooks.pre.length === 0 && hooks.post.length === 0) {
        console.log('  没有注册的 Hook');
      }
      console.log('');
      return true;
    },
  ];
}

