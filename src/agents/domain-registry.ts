import path from 'node:path';
import { AgentLoader, type AgentDefinition, BUILTIN_GENERAL_AGENT } from './loader.js';

/**
 * 垂直领域 Agent 运行时注册中枢（DomainAgentRegistry）。
 *
 * 职责：
 * 1. 统一对外门面：封装 AgentLoader，提供全局单例或多实例管理；
 * 2. 运行时缓存：内存缓存 AgentDefinitions，支持热重载（reload）；
 * 3. 兜底保障：向 Runtime/Worker 提供安全的 Agent 查找接口。
 */
export class DomainAgentRegistry {
  private loader: AgentLoader;
  private static instances = new Map<string, DomainAgentRegistry>();

  constructor(baseDir = '.', globalAgentsDir?: string) {
    this.loader = new AgentLoader(baseDir, globalAgentsDir);
    this.loader.load();
  }

  /**
   * 按工作区基础路径获取对应注册中心实例（单例池化缓存）
   */
  static getInstance(baseDir = '.', globalAgentsDir?: string): DomainAgentRegistry {
    const key = `${path.resolve(baseDir)}::${globalAgentsDir ? path.resolve(globalAgentsDir) : ''}`;
    let instance = DomainAgentRegistry.instances.get(key);
    if (!instance) {
      instance = new DomainAgentRegistry(baseDir, globalAgentsDir);
      DomainAgentRegistry.instances.set(key, instance);
    }
    return instance;
  }

  /**
   * 清空所有单例缓存（用于测试隔离）
   */
  static clearInstances(): void {
    DomainAgentRegistry.instances.clear();
  }

  /**
   * 获取指定 ID 的 Agent 定义，缺失时安全返回 general
   */
  get(id?: string): AgentDefinition {
    if (!id) return BUILTIN_GENERAL_AGENT;
    return this.loader.get(id);
  }

  /**
   * 查询是否存在指定 ID 的领域 Agent
   */
  has(id: string): boolean {
    return this.loader.has(id);
  }

  /**
   * 列出所有可用的领域 Agent（general 居首）
   */
  list(): AgentDefinition[] {
    return this.loader.list();
  }

  /**
   * 热重载所有已安装的领域 Agent 资产包
   */
  reload(): AgentDefinition[] {
    return this.loader.load();
  }
}
