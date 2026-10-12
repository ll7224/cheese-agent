import type { ChannelDefinition, IncomingMessage, OutgoingMessage } from './types.js';

/**
 * 飞书接入配置参数
 */
interface FeishuConfig {
  /** 飞书自建应用的 App ID（在飞书开放平台获取） */
  appId: string;
  /** 飞书自建应用的 App Secret */
  appSecret: string;
  /** 本地测试控制台（Dashboard）及 Webhook 运行端口（例如 3000） */
  port: number;
}

/**
 * 飞书 Bot 消息通道实现（FeishuChannel）。
 *
 * 核心技术特色：
 * 1. 生产级长连接模式（WebSocket Long Connection）：
 *    基于飞书官方 SDK 的 WSClient，建立安全双向长连接通道。
 *    彻底免去公网 IP、免去备案域名、免去 ngrok / 反向代理穿透，本地内网即可秒级接收飞书群聊及单聊事件！
 * 2. 开发者调试沙箱（Dashboard & Mock Webhook）：
 *    内置基于轻量 Web 框架 Hono 的本地控制台面板与 `/webhook/feishu` 端点。
 *    即使没有配置飞书 App 凭证，也可以直接在浏览器中发送消息模拟飞书真实通信流程。
 */
export class FeishuChannel implements ChannelDefinition {
  name = 'feishu';
  description = '飞书 Bot 消息通道（长连接模式）';

  private config: FeishuConfig;
  /** 外部消息到达时的分发回调句柄（通知 Gateway） */
  private messageHandler?: (msg: IncomingMessage) => void;
  /** Hono HTTP 本地服务器实例 */
  private httpServer?: any;
  /** 飞书 WebSocket 长连接客户端 */
  private wsClient?: any;
  /** 飞书官方 OpenAPI 客户端（用于调用发送消息接口） */
  private larkClient?: any;

  constructor(config: FeishuConfig) {
    this.config = config;
  }

  /**
   * 注册消息监听器（由 ChannelGateway 调用）
   */
  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  /**
   * 启动飞书通道服务
   */
  async start(): Promise<void> {
    // 1. 无论是否配置了飞书真实秘钥，均先启动本地 Web 调试面板
    await this.startDashboard();

    // 2. 如果未配置 APP_ID / APP_SECRET，平滑回退为本地 Mock 模式
    if (!this.config.appId || !this.config.appSecret) {
      console.log('    飞书未配置 APP_ID / APP_SECRET，仅启动 Dashboard');
      console.log('    用页面上的「发送测试消息」或 curl 测试 Channel 流程');
      return;
    }

    // 3. 动态导入飞书官方 OpenAPI SDK
    const lark = await import('@larksuiteoapi/node-sdk');

    // 初始化飞书 API Client
    this.larkClient = new lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });

    // 4. 构建飞书事件分发器（EventDispatcher）
    const dispatcher = new lark.EventDispatcher({});

    // 注册处理“接收消息 v1”事件（im.message.receive_v1）
    dispatcher.register({
      'im.message.receive_v1': (data) => {
        // 过滤非文本类消息（如图片、富文本、卡片等）
        if (data.message.message_type !== 'text') return;

        // 解析飞书消息 JSON 文本主体
        const content = JSON.parse(data.message.content);
        let text = content.text || '';

        // 剔除群聊中 @机器人 时自带的 @_user_xxx 占位标记，提取纯洁的用户指令
        if (data.message.mentions) {
          for (const m of data.message.mentions) {
            text = text.replace(m.key, '').trim();
          }
        }

        // 规范化消息结构，通知 Gateway
        if (text && this.messageHandler) {
          this.messageHandler({
            channelId: data.message.chat_id,
            senderId: data.sender.sender_id?.open_id || 'unknown',
            senderName: data.sender.sender_id?.open_id || 'unknown',
            text,
            raw: data,
          });
        }
      },
    });

    // 5. 启动飞书 WebSocket 客户端，与飞书开放平台建立双向长连接
    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: lark.LoggerLevel.warn,
    });

    await this.wsClient.start({ eventDispatcher: dispatcher });
    console.log('    飞书长连接已建立（无需 ngrok）');
  }

  /**
   * 停止通道服务并释放本地端口
   */
  async stop(): Promise<void> {
    if (this.httpServer) this.httpServer.close();
    this.wsClient?.close({ force: true });
  }

  /**
   * 逆向发送消息到飞书聊天会话中
   *
   * @param message 待发送的消息内容和目标 channelId
   */
  async send(message: OutgoingMessage): Promise<void> {
    if (!this.larkClient) {
      console.log(`    [feishu] 未配置飞书，跳过发送: ${message.text.slice(0, 50)}`);
      return;
    }

    try {
      // 调用飞书发送消息接口：im.message.create
      await this.larkClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: message.channelId,
          msg_type: 'text',
          content: JSON.stringify({ text: message.text }),
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`    [feishu] 发送失败: ${msg}`);
    }
  }

  /**
   * 启动基于 Hono 的轻量本地控制台服务（提供可视化状态与本地 Mock 发送测试能力）
   */
  private async startDashboard(): Promise<void> {
    const { Hono } = await import('hono');
    const { serve } = await import('@hono/node-server');

    const app = new Hono();
    app.use('*', async (context, next) => {
      const url = new URL(context.req.url);
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return context.json({ error: '仅允许本机访问' }, 403);
      const origin = context.req.header('origin');
      if (origin && origin !== url.origin) return context.json({ error: '不允许跨站请求' }, 403);
      if (context.req.method === 'POST' && !context.req.header('content-type')?.includes('application/json')) return context.json({ error: '需要 JSON 请求' }, 415);
      await next();
    });

    // 模拟 Webhook 接收端点：用于本地或 CI 环境直接通过 HTTP POST 模拟飞书消息传入
    app.post('/webhook/feishu', async (c) => {
      const body = await c.req.json();

      if (body.header?.event_type === 'im.message.receive_v1') {
        const event = body.event;
        if (event.message?.message_type === 'text') {
          const content = JSON.parse(event.message.content);
          const text = content.text?.replace(/@_user_\d+/g, '').trim();
          if (text && this.messageHandler) {
            this.messageHandler({
              channelId: event.message.chat_id || 'web-test',
              senderId: event.sender?.sender_id?.open_id || 'web-dashboard',
              senderName: event.sender?.sender_id?.open_id || 'web-dashboard',
              text,
              raw: body,
            });
          }
        }
      }

      return c.json({ code: 0 });
    });

    // 可视化 Web 控制台页面
    app.get('/', (c) => {
      const feishuStatus = this.config.appId ? '已连接（长连接模式）' : '未配置';
      const html = `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <title>Cheese Agent — Channel Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; min-height: 100vh; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .subtitle { color: #94a3b8; margin-bottom: 2rem; }
    .card { background: #1e293b; border-radius: 8px; padding: 1.5rem; margin-bottom: 1rem; }
    .card h2 { font-size: 1rem; color: #38bdf8; margin-bottom: 0.75rem; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; }
    .badge-ok { background: #065f46; color: #6ee7b7; }
    .badge-off { background: #78350f; color: #fcd34d; }
    .endpoint { font-family: monospace; background: #334155; padding: 4px 8px; border-radius: 4px; font-size: 0.85rem; }
    ul { list-style: none; }
    li { margin-bottom: 0.5rem; }
    textarea { width: 100%; background: #334155; border: 1px solid #475569; color: #e2e8f0; border-radius: 6px; padding: 0.75rem; font-family: monospace; font-size: 0.85rem; resize: vertical; min-height: 60px; }
    button { background: #2563eb; color: white; border: none; padding: 0.5rem 1.5rem; border-radius: 6px; cursor: pointer; margin-top: 0.5rem; font-size: 0.9rem; }
    button:hover { background: #1d4ed8; }
    #result { margin-top: 0.75rem; padding: 0.75rem; background: #334155; border-radius: 6px; font-family: monospace; font-size: 0.8rem; white-space: pre-wrap; display: none; }
  </style>
</head>
<body>
  <h1>Cheese Agent v1.0</h1>
  <p class="subtitle">Channel Dashboard</p>

  <div class="card">
    <h2>Channel 状态</h2>
    <ul>
      <li><span class="badge ${this.config.appId ? 'badge-ok' : 'badge-off'}">${feishuStatus}</span> feishu — 飞书 Bot 消息通道</li>
    </ul>
  </div>

  <div class="card">
    <h2>发送测试消息</h2>
    <p style="color: #94a3b8; font-size: 0.85rem; margin-bottom: 0.75rem;">通过模拟 webhook 发消息给 Agent，回复在终端查看</p>
    <textarea id="msg" placeholder="输入要发给 Agent 的消息...">你好</textarea>
    <button onclick="sendTest()">发送</button>
    <div id="result"></div>
  </div>

  <script>
    async function sendTest() {
      const text = document.getElementById('msg').value.trim();
      if (!text) return;
      const result = document.getElementById('result');
      result.style.display = 'block';
      result.textContent = '发送中...';
      try {
        const body = {
          header: { event_type: 'im.message.receive_v1' },
          event: {
            message: { message_type: 'text', content: JSON.stringify({ text }), chat_id: 'web-test' },
            sender: { sender_id: { open_id: 'web-dashboard' } }
          }
        };
        const res = await fetch('/webhook/feishu', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        result.textContent = 'OK — 查看终端输出';
      } catch (e) {
        result.textContent = e.message;
      }
    }
  </script>
</body>
</html>`;
      return c.html(html);
    });

    app.get('/health', (c) => c.text('OK'));

    // 启动本地监听
    this.httpServer = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: this.config.port });
    await new Promise<void>((resolve, reject) => { this.httpServer.once('listening', resolve); this.httpServer.once('error', reject); });
    console.log(`    Dashboard: http://localhost:${this.config.port}`);
  }
}
