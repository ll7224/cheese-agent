import fs from 'node:fs';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createMockModel } from '../mock-model.js';
import { loadConfig, CONFIG_FILE } from '../config/loader.js';
import type { CheeseAgentConfig, SuperAgentConfig, ModelConfig } from '../config/schema.js';

export type { ModelConfig };

/**
 * 统一获取并初始化大语言模型实例（Model Factory）。
 *
 * 设计理念与特性：
 * 1. 配置文件优先与多级级联降级（Cascade Priority）：
 *    - 支持通过形参直接传入 ModelConfig 或全局 CheeseAgentConfig / SuperAgentConfig；
 *    - 若未显式传参，则自动尝试加载本地配置文件（cheese-agent.config.json / super-agent.config.json）；
 *    - 若配置文件不存在或未提供必填参数，自动级联读取环境变量（.env）；
 *    - 针对缺失 API Key 的场景，自动优雅回退至 MockModel，保障系统整体可用性。
 *
 * 2. 多供应商多协议适配（Multi-Provider & Multi-Protocol）：
 *    - Google / Gemini：
 *      - 原生直连模式（GoogleGenerativeAI SDK）；
 *      - OpenAI 兼容中转网关模式（如 flashway.ai, one-api 等第三方代理网关）；
 *    - DashScope（通义千问）：
 *      - 阿里云百炼/灵积提供的 OpenAI 兼容协议接入；
 *    - OpenAI / Custom：
 *      - 标准 OpenAI 官方协议或私有化大模型 OpenAI 规范接口。
 *
 * @param customConfig 可选的自定义模型配置对象或完整应用配置对象
 * @returns 统一封装的 AI SDK LanguageModel 实例
 */
export function getModel(customConfig?: Partial<ModelConfig> | CheeseAgentConfig | SuperAgentConfig) {
  // ── 1. 解析配置源（入参 > 配置文件 > 环境变量） ────────────────────────
  let configModel: Partial<ModelConfig> = {};
  const hasConfigFile = fs.existsSync(CONFIG_FILE);

  if (customConfig) {
    if ('model' in customConfig && typeof customConfig.model === 'object' && customConfig.model !== null) {
      configModel = customConfig.model;
    } else {
      configModel = customConfig as Partial<ModelConfig>;
    }
  } else if (hasConfigFile) {
    try {
      const fullConfig = loadConfig();
      configModel = fullConfig.model || {};
    } catch (err) {
      console.warn(`  ⚠ 读取配置文件 ${CONFIG_FILE} 失败，回退至环境变量: ${(err as Error).message}`);
    }
  }

  // ── 2. 级联判定 Provider ──────────────────────────────────────────
  // 优先级：配置明确指定的 provider > 环境变量 MODEL_PROVIDER > 默认推断
  const provider = (
    configModel.provider ||
    process.env.MODEL_PROVIDER ||
    'openai'
  ).toLowerCase();
  if (provider === 'mock') return createMockModel();

  // ── 3. 级联判定 Model Name ─────────────────────────────────────────
  // 优先级：配置中的 name > 环境变量 MODEL_NAME > 针对 provider 的默认值
  const defaultModelName =
    provider === 'google' || provider === 'gemini'
      ? 'gemini-3.8-flash-medium'
      : provider === 'dashscope'
        ? 'qwen-plus-latest'
        : 'gpt-5.6-sol';

  const modelName = configModel.name || process.env.MODEL_NAME || defaultModelName;

  // ── 4. 级联解析 API Key ────────────────────────────────────────────
  // 优先从配置对象的 apiKey 字段获取；若为空则根据提供商提取对应环境变量
  let apiKey = configModel.apiKey || '';
  if (!apiKey) {
    if (provider === 'google' || provider === 'gemini') {
      apiKey =
        process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
        process.env.GEMINI_API_KEY ||
        process.env.GOOGLE_API_KEY ||
        process.env.DASHSCOPE_API_KEY ||
        process.env.OPENAI_API_KEY ||
        '';
    } else if (provider === 'dashscope') {
      apiKey = process.env.DASHSCOPE_API_KEY || process.env.OPENAI_API_KEY || '';
    } else {
      apiKey = process.env.OPENAI_API_KEY || process.env.DASHSCOPE_API_KEY || '';
    }
  }

  // ── 5. 级联解析 Base URL ───────────────────────────────────────────
  let baseURL = configModel.baseURL || '';
  if (!baseURL) {
    if (provider === 'google' || provider === 'gemini') {
      baseURL = process.env.GOOGLE_BASE_URL || '';
    } else if (provider === 'dashscope') {
      baseURL = process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    } else {
      baseURL = process.env.OPENAI_BASE_URL || '';
    }
  }

  // ── 6. 分支处理：Google / Gemini 提供商 ────────────────────────────
  if (provider === 'google' || provider === 'gemini') {
    // 判定是否为 OpenAI 兼容网关（如 Flashway, OneAPI, NewAPI 等反代服务）
    const isOpenAICompatible =
      Boolean(baseURL) &&
      (baseURL.includes('flashway.ai') ||
        baseURL.includes('/v1') ||
        process.env.GOOGLE_API_FORMAT === 'openai');

    if (isOpenAICompatible) {
      if (!apiKey) {
        console.warn('⚠️ 未检测到 Gemini 兼容网关 API Key，回退至 MockModel');
        return createMockModel();
      }
      console.log(`[Model] 通过 OpenAI 兼容网关接入 Gemini: ${modelName} (${baseURL})`);
      const openai = createOpenAI({
        baseURL,
        apiKey,
      });
      return openai.chat(modelName);
    }

    // Google 原生 SDK 模式直连
    if (!apiKey) {
      console.warn('⚠️ 未检测到 GOOGLE_GENERATIVE_AI_API_KEY，回退至 MockModel');
      return createMockModel();
    }

    console.log(`[Model] 通过 Google 原生 SDK 接入: ${modelName}`);
    const google = createGoogleGenerativeAI({
      apiKey,
      baseURL: baseURL || undefined,
    });
    return google(modelName);
  }

  // ── 7. 分支处理：DashScope 提供商（通义千问兼容模式） ───────────────
  if (provider === 'dashscope') {
    if (!apiKey) {
      console.warn('⚠️ 未检测到 DASHSCOPE_API_KEY，回退至 MockModel');
      return createMockModel();
    }

    const effectiveBaseURL = baseURL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    console.log(`[Model] 使用 DashScope 兼容模式接入: ${modelName} (${effectiveBaseURL})`);
    const openai = createOpenAI({
      baseURL: effectiveBaseURL,
      apiKey,
    });
    return openai.chat(modelName);
  }

  // ── 8. 分支处理：OpenAI / Custom / 通用 OpenAI 兼容协议 ───────────
  if (apiKey) {
    const effectiveBaseURL = baseURL || process.env.OPENAI_BASE_URL || 'http://127.0.0.1:8988';
    console.log(`[Model] 使用 OpenAI/Custom 提供商接入: ${modelName} (${effectiveBaseURL})`);
    const openai = createOpenAI({
      baseURL: effectiveBaseURL,
      apiKey,
    });
    return openai.chat(modelName);
  }

  // ── 9. 无有效凭据降级处理 ──────────────────────────────────────────
  console.warn('⚠️ 未检测到有效 API Key（配置或环境变量均为空），系统回退至 MockModel');
  return createMockModel();
}
