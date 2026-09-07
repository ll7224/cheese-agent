import type { CommandHandler } from './index.js';
import type { PluginManager } from '../plugins/manager.js';
import type { PluginDefinition } from '../plugins/types.js';

/**
 * 创建与 Plugin 管理相关的 CLI 交互命令处理器（/plugin 系列命令）。
 *
 * 支持的交互指令：
 * 1. `/plugin` 或 `/plugin list`：查看系统中已加载与可加载的插件列表及对应工具；
 * 2. `/plugin load <name>`：动态加载并激活指定插件，自动为其工具注入命名空间；
 * 3. `/plugin unload <name>`：卸载指定插件，调用销毁钩子并注销其名下所有工具。
 *
 * @param pluginManager 插件运行时管理器
 * @param availablePlugins 系统已安装/已知可用的插件定义映射（Key: 插件名, Value: 插件对象）
 */
export function createPluginCommands(
  pluginManager: PluginManager,
  availablePlugins: Map<string, PluginDefinition>,
): CommandHandler[] {
  return [
    // ---------------------- 1. /plugin 或 /plugin list ----------------------
    (cmd, _ctx) => {
      if (cmd !== '/plugin' && cmd !== '/plugin list') return false;

      const loaded = pluginManager.list();
      const unloaded = Array.from(availablePlugins.entries())
        .filter(([name]) => !loaded.find((p) => p.name === name));

      if (loaded.length === 0 && unloaded.length === 0) {
        console.log('\n[plugins] 没有可用的插件。\n');
        return true;
      }

      console.log('\n[plugins]');
      // 展示当前会话中已经激活的插件及其暴露的工具
      if (loaded.length > 0) {
        console.log('  已加载：');
        for (const p of loaded) {
          console.log(`    ${p.name} v${p.version} — ${p.description}`);
          console.log(`      工具: ${p.tools.join(', ')}`);
        }
      }
      // 展示尚未激活但可以在线装载的插件
      if (unloaded.length > 0) {
        console.log('  可加载：');
        for (const [name, def] of unloaded) {
          console.log(`    ${name} v${def.version} — ${def.description}`);
        }
      }
      console.log('');
      return true;
    },

    // ---------------------- 2. /plugin load <name> ----------------------
    (cmd, _ctx) => {
      const match = cmd.match(/^\/plugin\s+load\s+(\S+)$/);
      if (!match) return false;
      const name = match[1];

      const def = availablePlugins.get(name);
      if (!def) {
        console.log(`\n[plugins] 找不到插件: ${name}\n`);
        return true;
      }

      if (pluginManager.get(name)) {
        console.log(`\n[plugins] ${name} 已经加载了\n`);
        return true;
      }

      // 异步调用 load 进行激活、环境变量注入与工具注册
      pluginManager
        .load(def)
        .then((tools) => {
          console.log(`\n[plugins] 已加载 ${name}，注册了 ${tools.length} 个工具：`);
          for (const t of tools) console.log(`    ${t}`);
          console.log('');
        })
        .catch((err) => {
          console.log(`\n[plugins] 加载 ${name} 失败: ${err.message}\n`);
        });

      return true;
    },

    // ---------------------- 3. /plugin unload <name> ----------------------
    (cmd, _ctx) => {
      const match = cmd.match(/^\/plugin\s+unload\s+(\S+)$/);
      if (!match) return false;
      const name = match[1];

      // 异步执行卸载与清理
      pluginManager.unload(name).then((ok) => {
        if (ok) {
          console.log(`\n[plugins] 已卸载 ${name}，相关工具已移除\n`);
        } else {
          console.log(`\n[plugins] ${name} 未加载\n`);
        }
      });

      return true;
    },
  ];
}
