import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export interface StoredModel {
  id: string;
  label: string;
  provider: string; // 'deepseek' | 'openai' | 'google' | 'anthropic' | 'dashscope' | 'ollama' | 'custom'
  name: string; // model identifier, e.g. "deepseek-chat"
  models?: string[]; // list of enabled models under this config
  baseURL: string;
  apiKey: string;
  isDefault?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MaskedModel {
  id: string;
  label: string;
  provider: string;
  name: string;
  models: string[];
  baseURL: string;
  hasKey: boolean;
  maskedKey: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderPreset {
  provider: string;
  label: string;
  defaultBaseURL: string;
  defaultModel: string;
  recommendedModels: string[];
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  deepseek: {
    provider: 'deepseek',
    label: 'DeepSeek (深度求索)',
    defaultBaseURL: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    recommendedModels: ['deepseek-chat', 'deepseek-reasoner']
  },
  openai: {
    provider: 'openai',
    label: 'OpenAI (官方)',
    defaultBaseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    recommendedModels: ['gpt-4o', 'gpt-4o-mini', 'o3-mini', 'o1']
  },
  google: {
    provider: 'google',
    label: 'Google Gemini',
    defaultBaseURL: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-3.8-flash',
    recommendedModels: ['gemini-3.8-flash', 'gemini-2.5-pro']
  },
  anthropic: {
    provider: 'anthropic',
    label: 'Anthropic (Claude 兼容代理)',
    defaultBaseURL: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-3-7-sonnet',
    recommendedModels: ['claude-3-7-sonnet', 'claude-3-5-haiku']
  },
  dashscope: {
    provider: 'dashscope',
    label: '阿里云百炼 (通义千问 Qwen)',
    defaultBaseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus-latest',
    recommendedModels: ['qwen-plus-latest', 'qwen-max-latest', 'qwen-turbo-latest', 'deepseek-v3', 'deepseek-r1']
  },
  ollama: {
    provider: 'ollama',
    label: 'Ollama (本地运行)',
    defaultBaseURL: 'http://127.0.0.1:11434/v1',
    defaultModel: 'llama3.3',
    recommendedModels: ['llama3.3', 'qwen2.5-coder', 'deepseek-r1']
  },
  custom: {
    provider: 'custom',
    label: '自定义 (OpenAI 兼容中转/私有部署)',
    defaultBaseURL: '',
    defaultModel: '',
    recommendedModels: []
  }
};

export class ModelStore {
  private file: string;
  private dir: string;
  private models: StoredModel[] = [];

  constructor(customDir?: string) {
    this.dir = customDir || join(homedir(), '.cheese');
    this.file = join(this.dir, 'models.json');
    this.load();
  }

  private load() {
    try {
      if (!existsSync(this.dir)) {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      }
      if (existsSync(this.file)) {
        const raw = readFileSync(this.file, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.models = parsed;
          return;
        }
      }
    } catch (err) {
      console.warn('读取模型配置文件失败，将使用空模型池:', err);
    }
    this.models = [];
  }

  private save() {
    try {
      if (!existsSync(this.dir)) {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      }
      writeFileSync(this.file, JSON.stringify(this.models, null, 2), { mode: 0o600 });
    } catch (err) {
      console.error('保存模型配置文件失败:', err);
      throw new Error('无法保存模型配置文件至 ' + this.file);
    }
  }

  list(): MaskedModel[] {
    return this.models.map(m => this.mask(m));
  }

  get(id: string): StoredModel | undefined {
    return this.models.find(m => m.id === id);
  }

  getDefault(): StoredModel | undefined {
    return this.models.find(m => m.isDefault) || this.models[0];
  }

  private maskKey(key: string): string {
    if (!key) return '';
    if (key.length <= 8) return '****';
    return `${key.slice(0, 3)}****${key.slice(-4)}`;
  }

  private mask(m: StoredModel): MaskedModel {
    const models = Array.isArray(m.models) && m.models.length > 0
      ? m.models
      : (m.name ? [m.name] : []);
    return {
      id: m.id,
      label: m.label,
      provider: m.provider,
      name: m.name,
      models,
      baseURL: m.baseURL,
      hasKey: Boolean(m.apiKey),
      maskedKey: this.maskKey(m.apiKey),
      isDefault: Boolean(m.isDefault),
      createdAt: m.createdAt,
      updatedAt: m.updatedAt
    };
  }

  saveModel(input: {
    id?: string;
    label: string;
    provider: string;
    name: string;
    models?: string[];
    baseURL: string;
    apiKey?: string;
    isDefault?: boolean;
  }): MaskedModel {
    const now = new Date().toISOString();
    const existing = input.id ? this.get(input.id) : undefined;

    if (input.isDefault) {
      this.models.forEach(m => { m.isDefault = false; });
    }

    const cleanModels = Array.isArray(input.models)
      ? Array.from(new Set(input.models.map(s => String(s).trim()).filter(Boolean)))
      : [];

    const primaryName = input.name.trim() || cleanModels[0] || '';
    if (cleanModels.length === 0 && primaryName) {
      cleanModels.push(primaryName);
    }

    if (existing) {
      existing.label = input.label.trim() || existing.label;
      existing.provider = input.provider || existing.provider;
      existing.name = primaryName || existing.name;
      existing.models = cleanModels.length > 0 ? cleanModels : (existing.models || [existing.name]);
      existing.baseURL = input.baseURL.trim() || existing.baseURL;
      if (input.apiKey !== undefined && input.apiKey !== '') {
        existing.apiKey = input.apiKey.trim();
      }
      if (input.isDefault !== undefined) {
        existing.isDefault = input.isDefault;
      }
      existing.updatedAt = now;
      this.save();
      return this.mask(existing);
    }

    const newModel: StoredModel = {
      id: randomUUID(),
      label: input.label.trim() || primaryName || '未命名配置',
      provider: input.provider || 'custom',
      name: primaryName,
      models: cleanModels,
      baseURL: input.baseURL.trim(),
      apiKey: (input.apiKey || '').trim(),
      isDefault: input.isDefault ?? (this.models.length === 0),
      createdAt: now,
      updatedAt: now
    };

    this.models.push(newModel);
    this.save();
    return this.mask(newModel);
  }

  resolveModel(modelId?: string, modelName?: string): StoredModel | undefined {
    let base: StoredModel | undefined;
    let targetName = modelName;

    if (modelId) {
      if (modelId.includes(':')) {
        const parts = modelId.split(':');
        const configId = parts[0];
        targetName = parts.slice(1).join(':');
        base = this.get(configId);
      } else {
        base = this.get(modelId);
        if (!base) {
          for (const m of this.models) {
            if (m.name === modelId || (m.models && m.models.includes(modelId))) {
              base = m;
              targetName = modelId;
              break;
            }
          }
        }
      }
    }

    if (!base) {
      base = this.getDefault();
    }

    if (!base) return undefined;

    const finalName = targetName || base.name || (base.models && base.models[0]) || '';
    return {
      ...base,
      name: finalName
    };
  }

  deleteModel(id: string): boolean {
    const idx = this.models.findIndex(m => m.id === id);
    if (idx === -1) return false;
    const [deleted] = this.models.splice(idx, 1);
    if (deleted.isDefault && this.models.length > 0) {
      this.models[0].isDefault = true;
    }
    this.save();
    return true;
  }

  setDefault(id: string): boolean {
    const target = this.get(id);
    if (!target) return false;
    this.models.forEach(m => { m.isDefault = m.id === id; });
    this.save();
    return true;
  }
}

export function normalizeBaseURL(url: string): string {
  let clean = url.trim().replace(/\/+$/, '');
  // Auto-complete /v typo to /v1
  if (clean.endsWith('/v')) {
    clean = `${clean}1`;
  }
  // Strip trailing endpoint paths if accidentally pasted
  clean = clean.replace(/\/chat\/completions\/?$/, '').replace(/\/completions\/?$/, '').replace(/\/models\/?$/, '');
  return clean;
}

export function extractModelIds(data: any): string[] {
  if (!data) return [];
  const results: string[] = [];

  const add = (val: any) => {
    if (!val) return;
    let name = '';
    if (typeof val === 'string') {
      name = val;
    } else if (typeof val === 'object') {
      name = String(val.id || val.name || val.model || '');
    }
    // Clean leading models/ namespace (e.g. from Google or Antigravity proxy)
    const cleaned = name.trim().replace(/^models\//, '');
    if (cleaned && !results.includes(cleaned)) {
      results.push(cleaned);
    }
  };

  if (Array.isArray(data)) {
    data.forEach(add);
  } else if (Array.isArray(data.data)) {
    data.data.forEach(add);
  } else if (Array.isArray(data.models)) {
    data.models.forEach(add);
  } else if (Array.isArray(data.result)) {
    data.result.forEach(add);
  }

  return results;
}

export async function testConnection(input: {
  provider: string;
  baseURL: string;
  apiKey: string;
  name: string;
}): Promise<{ ok: boolean; latency: number; latencyMs: number; message: string }> {
  const start = Date.now();
  const provider = (input.provider || 'custom').toLowerCase();
  const cleanBaseURL = normalizeBaseURL(input.baseURL || '');
  const apiKey = (input.apiKey || '').trim();
  const modelName = input.name.trim();

  if (!modelName) {
    throw new Error('请指定模型名称 (Model ID)');
  }

  // 1. Google Native SDK Endpoint (only when pointing directly to generativelanguage.googleapis.com)
  if (provider === 'google' && cleanBaseURL.includes('generativelanguage.googleapis.com')) {
    const url = `${cleanBaseURL}/models/${modelName}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Cheese-Agent/1.0' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'ping' }] }]
      }),
      signal: AbortSignal.timeout(15000)
    });
    const latency = Date.now() - start;
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Google API 返回错误 (HTTP ${res.status}): ${err.slice(0, 150)}`);
    }
    return { ok: true, latency, latencyMs: latency, message: `连接成功 (${latency}ms)` };
  }

  // 2. OpenAI-Compatible & Reverse Proxy / CPA endpoints
  if (!cleanBaseURL) {
    throw new Error('未配置 BaseURL 地址');
  }

  // Build candidate completion endpoints
  const candidates: string[] = [];
  if (cleanBaseURL.includes('/v1')) {
    candidates.push(`${cleanBaseURL}/chat/completions`);
  } else {
    candidates.push(`${cleanBaseURL}/v1/chat/completions`);
    candidates.push(`${cleanBaseURL}/chat/completions`);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'Cheese-Agent/1.0',
    ...(apiKey ? {
      'Authorization': `Bearer ${apiKey}`,
      'x-api-key': apiKey
    } : {})
  };

  const body = JSON.stringify({
    model: modelName,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1
  });

  let lastError = '';
  for (const endpoint of candidates) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(15000)
      });

      const latency = Date.now() - start;

      if (res.status === 401 || res.status === 403) {
        const err = await res.text().catch(() => '');
        if (err.includes('Missing API key') || !apiKey) {
          throw new Error('端点需要 API Key 鉴权，请先填写密钥');
        }
        if (err.includes('Invalid API key') || res.status === 401) {
          throw new Error('API Key 无效或未授权，请检查密钥是否正确');
        }
        throw new Error(`鉴权失败 (HTTP ${res.status}): ${err.slice(0, 120)}`);
      }

      if (!res.ok) {
        const err = await res.text().catch(() => '');
        lastError = `HTTP ${res.status}: ${err.slice(0, 150)}`;
        continue;
      }

      return { ok: true, latency, latencyMs: latency, message: `连接成功 (${latency}ms)` };
    } catch (err: any) {
      if (err.message?.includes('API Key') || err.message?.includes('鉴权失败')) throw err;
      const detail = err.cause?.message || err.cause?.code || err.message || String(err);
      lastError = detail === 'fetch failed' ? '无法连通服务 (网络中断、TLS握手失败或需开启代理)' : detail;
    }
  }

  throw new Error(`请求失败: ${lastError || '无法连通指定端点'}`);
}

export async function fetchRemoteModels(input: {
  baseURL: string;
  apiKey?: string;
}): Promise<string[]> {
  const cleanBaseURL = normalizeBaseURL(input.baseURL || '');
  const apiKey = (input.apiKey || '').trim();
  if (!cleanBaseURL) throw new Error('请先填写 BaseURL');

  // Candidate endpoints for models list
  const candidates: string[] = [];
  if (cleanBaseURL.includes('/v1')) {
    candidates.push(`${cleanBaseURL}/models`);
  } else {
    // Standard OpenAI proxy is mounted at /v1/models
    candidates.push(`${cleanBaseURL}/v1/models`);
    candidates.push(`${cleanBaseURL}/models`);
  }

  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'User-Agent': 'Cheese-Agent/1.0',
    ...(apiKey ? {
      'Authorization': `Bearer ${apiKey}`,
      'x-api-key': apiKey,
      'api-key': apiKey
    } : {})
  };

  let lastError = '';
  for (const endpoint of candidates) {
    try {
      const res = await fetch(endpoint, {
        headers,
        signal: AbortSignal.timeout(15000)
      });

      if (res.status === 401 || res.status === 403) {
        const err = await res.text().catch(() => '');
        if (err.includes('Missing API key') || !apiKey) {
          throw new Error('该端点需要身份鉴权，请先在下方输入 API Key 后再拉取模型');
        }
        if (err.includes('Invalid API key') || res.status === 401) {
          throw new Error('API Key 无效或未授权该端点，请检查密钥是否正确');
        }
        throw new Error(`认证失败 (HTTP ${res.status}): ${err.slice(0, 100)}`);
      }

      if (!res.ok) {
        const err = await res.text().catch(() => '');
        lastError = `HTTP ${res.status}: ${err.slice(0, 120)}`;
        continue;
      }

      const data = await res.json() as any;
      const list = extractModelIds(data);
      if (list.length > 0) {
        return list;
      }
    } catch (err: any) {
      if (err.message?.includes('API Key') || err.message?.includes('认证失败')) throw err;
      const detail = err.cause?.message || err.cause?.code || err.message || String(err);
      lastError = detail === 'fetch failed' ? '无法连通服务 (网络中断、TLS握手失败或需开启代理)' : detail;
    }
  }

  throw new Error(lastError || '端点未返回可用模型列表');
}
