import { createInterface } from 'node:readline';
import fs from 'node:fs';
import { CONFIG_FILE } from './loader.js';

/**
 * 交互式配置初始化向导（CLI Wizard）。
 *
 * 紧密贴合项目当前接入的技术栈：
 * 1. 大模型（LLM）：
 *    - Google Gemini（默认推荐通过 Flashway OpenAI 兼容网关接入 gemini-3.8-flash / gemini-3.7-flash）
 *    - DashScope（阿里云百炼通义千问兼容模式 qwen-plus-latest）
 *    - OpenAI（原生/中转网关 gpt-5.6-sol）
 * 2. 向量知识库（RAG）：
 *    - 阿里云百炼 DashScope 文本向量化服务（qwen3.7-text-embedding，1024 维）
 * 3. 飞书 Channel、Sub-Agent 并发控制及上下文防线等全套基础设施配置。
 */
export async function runInit() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => {
      console.log(q);
      rl.question('  > ', resolve);
    });

  console.log('\n  🧀 Cheese Agent 智能配置向导\n');

  if (fs.existsSync(CONFIG_FILE)) {
    const overwrite = await ask(`  ${CONFIG_FILE} 已存在，是否覆盖? (y/N): `);
    if (overwrite.toLowerCase() !== 'y') {
      console.log('  已取消\n');
      rl.close();
      return;
    }
  }

  // ── 1. 大模型提供商与规格选择 ──────────────────────────
  console.log('  请选择主语言模型 (LLM):\n');
  console.log('    1. Google Gemini 3.8 Flash (推荐，基于 Flashway 兼容网关，均衡且强大)');
  console.log('    2. Google Gemini 3.7 Flash (快速，高性价比)');
  console.log('    3. 阿里云 DashScope 通义千问 (qwen-plus-latest)');
  console.log('    4. OpenAI GPT-5.6 (gpt-5.6-sol)\n');
  const modelChoice = (await ask('  选择模型 [1]: ')) || '1';

  let provider = 'google';
  let modelName = 'gemini-3.8-flash';
  let baseURL = 'https://api.flashway.ai/v1';
  let defaultKeyPlaceholder = '${GOOGLE_GENERATIVE_AI_API_KEY}';

  if (modelChoice === '2') {
    provider = 'google';
    modelName = 'gemini-3.7-flash-high';
    baseURL = 'https://api.flashway.ai/v1';
    defaultKeyPlaceholder = '${GOOGLE_GENERATIVE_AI_API_KEY}';
  } else if (modelChoice === '3') {
    provider = 'dashscope';
    modelName = 'qwen-plus-latest';
    baseURL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    defaultKeyPlaceholder = '${DASHSCOPE_API_KEY}';
  } else if (modelChoice === '4') {
    provider = 'openai';
    modelName = 'gpt-5.6-sol';
    baseURL = 'https://api.openai.com/v1';
    defaultKeyPlaceholder = '${OPENAI_API_KEY}';
  }

  const apiKeyInput = await ask(
    `\n  ${provider === 'google' ? 'Google/Flashway' : provider === 'dashscope' ? 'DashScope' : 'OpenAI'} API Key (留空默认使用环境变量 ${defaultKeyPlaceholder}): `,
  );

  // ── 2. RAG 知识库配置（基于 DashScope Embedding） ──────
  console.log('\n  ── RAG 知识库配置 ──');
  console.log('  当前项目知识库使用 阿里云 DashScope qwen3.7-text-embedding (1024 维)');
  const ragApiKeyInput = await ask(
    '  DashScope API Key (用于文本向量化，留空默认使用环境变量 ${DASHSCOPE_API_KEY}): ',
  );

  // ── 3. 飞书 Channel ──────────────────────────
  console.log('\n  ── 通讯渠道配置 ──');
  const enableFeishu = (await ask('  启用飞书 Channel? (y/N): ')).toLowerCase() === 'y';
  let feishuAppId = '';
  let feishuAppSecret = '';
  if (enableFeishu) {
    feishuAppId = await ask('  飞书 App ID (留空默认 ${FEISHU_APP_ID}): ');
    feishuAppSecret = await ask('  飞书 App Secret (留空默认 ${FEISHU_APP_SECRET}): ');
  }

  // ── 4. Sub-Agent 并发控制 ─────────────────────
  console.log('\n  ── 子 Agent 并发设置 ──');
  const concurrentStr = await ask('  子 Agent 最大并发数 [3]: ');
  const maxConcurrent = parseInt(concurrentStr, 10) || 3;

  // ── 5. 生成标准配置对象 ──────────────────────────
  const config = {
    version: '1.0',
    model: {
      provider,
      name: modelName,
      baseURL,
      apiKey: apiKeyInput || defaultKeyPlaceholder,
    },
    rag: {
      enabled: true,
      docsDir: 'docs',
      provider: 'dashscope',
      model: 'qwen3.7-text-embedding',
      apiKey: ragApiKeyInput || '${DASHSCOPE_API_KEY}',
      dimensions: 1024,
    },
    plugins: [
      { name: 'supabase', enabled: false, config: {} },
    ],
    channels: {
      feishu: {
        enabled: enableFeishu,
        appId: feishuAppId || '${FEISHU_APP_ID}',
        appSecret: feishuAppSecret || '${FEISHU_APP_SECRET}',
        port: 3000,
      },
    },
    agents: {
      maxSpawnDepth: 1,
      maxConcurrent,
      defaultTimeout: 60000,
    },
    security: {
      defaultRole: 'developer',
      auditLog: true,
      bashTimestamp: true,
    },
    memory: {
      dataDir: '.',
    },
    cron: {
      enabled: true,
      dataDir: '.',
    },
    session: {
      id: 'default',
    },
    usage: {
      trackingFile: '.usage/today.jsonl',
    },
  };

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
  console.log(`\n  ✓ 配置文件 ${CONFIG_FILE} 已成功生成`);

  // ── 6. 生成或补充 .env 环境变量模板 ──────────────────────────
  const envLines: string[] = [];
  if (provider === 'google') {
    if (apiKeyInput) envLines.push(`GOOGLE_GENERATIVE_AI_API_KEY=${apiKeyInput}`);
    envLines.push(`GOOGLE_BASE_URL=${baseURL}`);
    envLines.push(`MODEL_PROVIDER=google`);
    envLines.push(`MODEL_NAME=${modelName}`);
  } else if (provider === 'dashscope') {
    if (apiKeyInput) envLines.push(`DASHSCOPE_API_KEY=${apiKeyInput}`);
    envLines.push(`MODEL_PROVIDER=dashscope`);
    envLines.push(`MODEL_NAME=${modelName}`);
  } else if (provider === 'openai') {
    if (apiKeyInput) envLines.push(`OPENAI_API_KEY=${apiKeyInput}`);
    envLines.push(`MODEL_PROVIDER=openai`);
    envLines.push(`MODEL_NAME=${modelName}`);
  }

  if (ragApiKeyInput && !envLines.some((l) => l.startsWith('DASHSCOPE_API_KEY='))) {
    envLines.push(`DASHSCOPE_API_KEY=${ragApiKeyInput}`);
  }

  if (enableFeishu) {
    if (feishuAppId) envLines.push(`FEISHU_APP_ID=${feishuAppId}`);
    if (feishuAppSecret) envLines.push(`FEISHU_APP_SECRET=${feishuAppSecret}`);
  }

  if (envLines.length > 0) {
    if (!fs.existsSync('.env')) {
      fs.writeFileSync('.env', envLines.join('\n') + '\n');
      console.log('  ✓ .env 环境变量文件已创建');
    } else {
      console.log('  ℹ 检测到 .env 已存在，保留现有 .env');
    }
  }

  console.log('\n  🚀 初始化完成！启动 Agent 请运行: pnpm start\n');
  rl.close();
}
