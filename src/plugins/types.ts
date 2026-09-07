import type { ToolDefinition } from '../tools/registry.js';

/**
 * 插件配置字典：
 * 支持键值对形式的自定义配置（如 API Key、Endpoint、开关等）。
 * 在载入时如果字符串值形如 `${ENV_VAR}`，会被 PluginManager 自动替换为环境变量值。
 */
export interface PluginConfig {
  [key: string]: string | number | boolean;
}

/**
 * 宿主系统传递给插件的上下文 API 句柄：
 * 插件通过此 API 与 Agent 宿主环境进行安全受控的交互。
 */
export interface PluginApi {
  /**
   * 注册由该插件提供的工具列表：
   * 宿主会自动为工具名称加上命名空间前缀 `${pluginName}__${toolName}`，
   * 并将带有命名空间的工具注册进系统的 ToolRegistry 中。
   */
  registerTools(tools: ToolDefinition[]): void;

  /**
   * 获取解析后的配置对象（已完成环境变量解析）。
   */
  getConfig(): PluginConfig;

  /**
   * 插件标准输出日志，会自动带有统一的 `[plugin:${name}]` 前缀。
   */
  log(message: string): void;
}

/**
 * 插件定义契约规范：
 * 任何自定义业务插件（如 Supabase、GitLab、Docker 等）都必须实现此接口。
 */
export interface PluginDefinition {
  /** 插件唯一英文标识符（例如: 'supabase'），将作为工具前缀的命名空间 */
  name: string;
  /** 插件语义化版本号 */
  version: string;
  /** 插件功能描述，用于在 /plugin 列表中对用户展示 */
  description: string;
  /** 插件默认配置模板（支持 `${ENV_NAME}` 语法） */
  config?: PluginConfig;

  /**
   * 插件激活生命周期钩子：
   * 在插件被装载（load）时触发。插件在此处读取配置、初始化网络连接并调用 `api.registerTools` 注册工具。
   */
  activate(api: PluginApi): Promise<void> | void;

  /**
   * 插件销毁生命周期钩子（可选）：
   * 在插件被卸载（unload）或系统关闭时触发。用于关闭长连接、清理临时资源等。
   */
  destroy?(): Promise<void> | void;
}
