import type { ToolRegistry, ToolDefinition } from '../tools/registry.js';
import type { PluginDefinition, PluginConfig, PluginApi } from './types.js';

/**
 * 内部维护的已装载插件实例结构体
 */
interface LoadedPlugin {
  /** 插件原始定义定义对象 */
  definition: PluginDefinition;
  /** 该插件注册成功的所有工具的完整名称（带有 `${pluginName}__` 前缀） */
  tools: string[];
}

/**
 * 插件生命周期与依赖注入管理器。
 *
 * 核心职责：
 * 1. 负责插件的动态装载（load）、环境变量解析、上下文 API 注入；
 * 2. 统一管理工具的命名空间隔离（Namespace Prefix），避免多个插件工具名冲突；
 * 3. 负责插件的卸载（unload）、销毁钩子调用（destroy）及工具反注册。
 */
export class PluginManager {
  /** 存储已激活插件的映射表（Key 为插件名称） */
  private plugins = new Map<string, LoadedPlugin>();
  /** Agent 全局工具注册表引用 */
  private registry: ToolRegistry;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  /**
   * 动态装载并激活一个插件。
   *
   * @param definition 插件定义对象
   * @param config 外部传入的自定义配置（可覆盖插件默认配置）
   * @returns 成功注册到系统的完整工具名列表
   */
  async load(definition: PluginDefinition, config?: PluginConfig): Promise<string[]> {
    if (this.plugins.has(definition.name)) {
      throw new Error(`插件 "${definition.name}" 已加载`);
    }

    // 1. 深度合并默认配置与自定义配置，并解析其中的 ${ENV_VAR} 环境变量
    const resolvedConfig = this.resolveEnvVars({
      ...definition.config,
      ...config,
    });

    const registeredTools: string[] = [];

    // 2. 构造传递给插件的受控沙箱 API
    const api: PluginApi = {
      // 工具注册注入：强制给插件内工具施加 `${pluginName}__${toolName}` 命名空间隔离
      registerTools: (tools: ToolDefinition[]) => {
        for (const tool of tools) {
          const prefixedName = `${definition.name}__${tool.name}`;
          const prefixedTool: ToolDefinition = {
            ...tool,
            name: prefixedName,
            description: `[Plugin:${definition.name}] ${tool.description}`,
          };
          this.registry.register(prefixedTool);
          registeredTools.push(prefixedName);
        }
      },
      getConfig: () => resolvedConfig,
      log: (message: string) => {
        console.log(`  [plugin:${definition.name}] ${message}`);
      },
    };

    // 3. 执行插件的 activate 生命周期钩子
    try {
      await definition.activate(api);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [plugin:${definition.name}] 激活失败: ${msg}`);
      throw err;
    }

    // 4. 存入已加载插件集合
    this.plugins.set(definition.name, {
      definition,
      tools: registeredTools,
    });

    return registeredTools;
  }

  /**
   * 动态卸载指定插件：
   * 调用插件的销毁钩子（destroy），并从全局 ToolRegistry 中完全清理其注册的工具。
   *
   * @param name 插件名称
   */
  async unload(name: string): Promise<boolean> {
    const plugin = this.plugins.get(name);
    if (!plugin) return false;

    // 1. 调用销毁钩子释放长连接、计时器等底层资源
    if (plugin.definition.destroy) {
      try {
        await plugin.definition.destroy();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  [plugin:${name}] destroy 出错: ${msg}`);
      }
    }

    // 2. 从 Agent 工具注册表中反注册对应工具
    for (const toolName of plugin.tools) {
      this.registry.unregister(toolName);
    }

    // 3. 从管理器中剔除
    this.plugins.delete(name);
    return true;
  }

  /**
   * 卸载所有当前已激活的插件
   */
  async unloadAll(): Promise<void> {
    const names = Array.from(this.plugins.keys());
    for (const name of names) {
      await this.unload(name);
    }
  }

  /**
   * 获取指定名称的已装载插件实例信息
   */
  get(name: string): LoadedPlugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * 列出所有当前已加载的插件元数据列表
   */
  list(): Array<{ name: string; version: string; description: string; tools: string[] }> {
    return Array.from(this.plugins.values()).map((p) => ({
      name: p.definition.name,
      version: p.definition.version,
      description: p.definition.description,
      tools: p.tools,
    }));
  }

  /**
   * 辅助函数：解析配置中的环境变量占位符
   * 将 "${MY_KEY}" 提取为 process.env.MY_KEY 的实际运行时值。
   */
  private resolveEnvVars(config: PluginConfig): PluginConfig {
    const resolved: PluginConfig = {};
    for (const [key, value] of Object.entries(config)) {
      if (typeof value === 'string' && value.startsWith('${') && value.endsWith('}')) {
        const envKey = value.slice(2, -1);
        resolved[key] = process.env[envKey] || '';
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  }
}
