import type { CommandHandler } from './index.js';
import type { ChannelGateway } from '../channels/gateway.js';

/**
 * 创建与 Channel（消息通道）相关的 CLI 控制台交互命令。
 *
 * 支持指令：
 * 1. `/channel` 或 `/channel list`：列出当前系统中网关（Gateway）已注册的所有外部通信通道及其说明。
 *
 * @param gateway 全局消息通道网关实例
 */
export function createChannelCommands(gateway: ChannelGateway): CommandHandler[] {
  return [
    // /channel 或 /channel list 命令处理器
    (cmd, _ctx) => {
      if (cmd !== '/channel' && cmd !== '/channel list') return false;

      const channels = gateway.list();
      if (channels.length === 0) {
        console.log('\n[channels] 没有注册的通道。\n');
        return true;
      }

      console.log('\n[channels]');
      for (const ch of channels) {
        console.log(`  ${ch.name} — ${ch.description}`);
      }
      console.log('');
      return true;
    },
  ];
}
