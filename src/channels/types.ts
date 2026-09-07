/**
 * 接收到的外部渠道消息结构体（从外部聊天平台进来的消息）。
 */
export interface IncomingMessage {
  /** 消息所属的会话/群聊/频道 ID（例如飞书中的 chat_id） */
  channelId: string;
  /** 发送者的唯一身份标识（如飞书 open_id、微信 openid 等） */
  senderId: string;
  /** 发送者的昵称/显示名称 */
  senderName: string;
  /** 用户输入的纯文本内容（通常已去除 @机器人 等噪音前缀） */
  text: string;
  /** 平台推送的原始事件对象 payload，保留备查扩展 */
  raw?: unknown;
}

/**
 * 待发送到外部渠道的消息结构体（Agent 回复给外部聊天平台的消息）。
 */
export interface OutgoingMessage {
  /** 目标会话/群聊/频道 ID */
  channelId: string;
  /** 接收者 ID（单聊模式下的用户 open_id，群聊模式下可选） */
  recipientId: string;
  /** Agent 生成并准备回复的文本内容 */
  text: string;
}

/**
 * 消息通道（Channel）统一抽象契约规范。
 * 任何接入系统的即时通讯平台（如飞书、企业微信、钉钉、Slack、Discord 等）都必须实现此接口。
 */
export interface ChannelDefinition {
  /** 通道唯一英文标识符（例如: 'feishu', 'dingtalk', 'slack'） */
  name: string;
  /** 通道功能简述（在 CLI 或 Dashboard 展示） */
  description: string;

  /** 启动通道长连接监听或 Webhook HTTP 服务 */
  start(): Promise<void> | void;
  /** 停止通道服务，释放网络端口与长连接 */
  stop(): Promise<void> | void;
  /** 向该渠道的目标会话或用户发送一条消息 */
  send(message: OutgoingMessage): Promise<void>;

  /**
   * 注册外部消息监听回调：
   * 当通道从外部平台（如飞书 WebSocket/Webhook）收到新消息后，调用该 handler 将数据推给 Gateway 网关。
   */
  onMessage?: (handler: (msg: IncomingMessage) => void) => void;
}
