import type { ModelMessage } from 'ai';
import type { ChannelDefinition, IncomingMessage, OutgoingMessage } from './types.js';
import type { ToolRegistry } from '../tools/registry.js';
import { executeAgent as agentLoop } from '../runtime/execution.js';

/**
 * 网关构造参数选项
 */
interface LegacyGatewayOptions {
  /** LLM 模型实例 */
  model: any;
  /** 全局工具注册表引用 */
  registry: ToolRegistry;
  /** 动态构建系统 Prompt 的回调函数 */
  buildSystem: () => string;
}

type GatewayOptions = LegacyGatewayOptions | { run: (channelName: string, message: IncomingMessage) => Promise<string> };

/**
 * 跨平台消息通道统一网关（ChannelGateway）。
 *
 * 核心架构定位：
 * 作为 Agent 与外部世界（飞书、钉钉、Slack、Web 等）通信的“中央交换机”。
 *
 * 主要职责：
 * 1. 统一管理多个接入通道的生命周期（注册、批量启动 startAll、批量关闭 stopAll）；
 * 2. 多租户会话隔离：基于 `${channelName}:${senderId}` 隔离不同渠道下不同用户的对话上下文；
 * 3. 消息调度驱动：收到外部消息后包装为 User Message，拉起 `agentLoop` 执行推理与工具调用；
 * 4. 自动回复分发：将大模型最终产出的 Assistant 文本回复逆向路由并通过原渠道发送回用户。
 */
export class ChannelGateway {
  /** 已注册通道集合（Key: 通道名称） */
  private channels = new Map<string, ChannelDefinition>();
  /** 会话上下文存储表（Key 为会话隔离标识，Value 为消息历史数组） */
  private sessions = new Map<string, ModelMessage[]>();
  /** 依赖配置 */
  private options: GatewayOptions;

  constructor(options: GatewayOptions) {
    this.options = options;
  }

  /**
   * 注册一个消息通道实例到网关中。
   * 同时绑定该通道的消息接收监听器（onMessage）。
   *
   * @param channel 实现了 ChannelDefinition 的通道实例（如 FeishuChannel）
   */
  register(channel: ChannelDefinition): void {
    this.channels.set(channel.name, channel);

    // 绑定事件驱动回调：当通道收到外部新消息时，转发给 handleIncoming 统一处理
    channel.onMessage?.((msg: IncomingMessage) => {
      void this.handleIncoming(channel.name, msg).catch(error => console.error(`[${channel.name}] 执行失败: ${error instanceof Error ? error.message : String(error)}`));
    });
  }

  /**
   * 批量异步启动所有已注册的消息通道。
   */
  async startAll(): Promise<void> {
    for (const [name, ch] of this.channels) {
      try {
        await ch.start();
        console.log(`  [gateway] ✓ ${name} 已启动`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  [gateway] ✗ ${name} 启动失败: ${msg}`);
      }
    }
  }

  /**
   * 批量停止并释放所有通道的长连接与端口。
   */
  async stopAll(): Promise<void> {
    for (const [, ch] of this.channels) {
      await ch.stop();
    }
  }

  /**
   * 核心消息调度中枢：处理接收到的外部通道消息。
   *
   * @param channelName 来源渠道名称（例如 'feishu'）
   * @param msg 统一规范化的进站消息体
   */
  private async handleIncoming(channelName: string, msg: IncomingMessage): Promise<void> {
    if ('run' in this.options) {
      const text = await this.options.run(channelName, msg);
      if (text) await this.channels.get(channelName)?.send({ channelId: msg.channelId, recipientId: msg.senderId, text });
      return;
    }
    // 1. 生成基于渠道 + 发送者唯一标识的会话隔离 Key（实现多渠道单人状态隔离）
    const sessionKey = `${channelName}:${msg.senderId}`;
    console.log(`\n  [${channelName}] ${msg.senderName}: ${msg.text}`);

    // 2. 提取或初始化会话历史数组
    if (!this.sessions.has(sessionKey)) {
      this.sessions.set(sessionKey, []);
    }
    const messages = this.sessions.get(sessionKey)!;

    // 3. 追加用户消息
    const userMsg: ModelMessage = { role: 'user', content: msg.text };
    messages.push(userMsg);

    // 4. 编译系统 Prompt 并记录调用前消息长度
    const system = this.options.buildSystem();

    // 5. 驱动 Agent 核心循环进行思考、Tool 调用与生成
    await agentLoop(
      this.options.model,
      this.options.registry,
      messages,
      system,
    );

    // 6. 从更新后的历史记录末尾提取最终的 Assistant 文本回复
    const lastMsg = messages[messages.length - 1];
    let replyText = '';
    if (lastMsg && lastMsg.role === 'assistant') {
      const content = lastMsg.content;
      if (typeof content === 'string') {
        replyText = content;
      } else if (Array.isArray(content)) {
        replyText = content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('');
      }
    }

    // 7. 将推理回复逆向发送给原渠道的对应目标
    if (replyText) {
      const channel = this.channels.get(channelName);
      if (channel) {
        const outgoing: OutgoingMessage = {
          channelId: msg.channelId,
          recipientId: msg.senderId,
          text: replyText,
        };
        await channel.send(outgoing);
        console.log(`  [${channelName}] → ${replyText.slice(0, 80)}${replyText.length > 80 ? '...' : ''}`);
      }
    }
  }

  /**
   * 列出当前网关下所有通道的概要信息
   */
  list(): Array<{ name: string; description: string }> {
    return Array.from(this.channels.values()).map((ch) => ({
      name: ch.name,
      description: ch.description,
    }));
  }
}
