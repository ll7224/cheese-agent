import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import { CheeseAgentConfigSchema, type CheeseAgentConfig } from '../config/schema.js';

interface Credential { marker: string; file?: string; path?: string[]; env?: string; directory: string }
export interface ConfigSnapshot { id: string; values: CheeseAgentConfig; credentials: Credential[] }
const secretKey = /apiKey|appSecret|password|token|secret/i;
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
function environment(directory: string) {
  const path = join(directory, '.env');
  return { ...(existsSync(path) ? parse(readFileSync(path)) : {}), ...process.env };
}
function substitute(value: string, directory: string) {
  const env = environment(directory);
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => {
    if (!env[name]) throw new Error(`环境变量 ${name} 未设置`);
    return env[name]!;
  });
}
function merge(base: any, override: any): any {
  if (!object(base) || !object(override)) return override;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) result[key] = merge(base[key], value);
  return result;
}
export function captureConfig(commonDirectory: string, workspace: string): ConfigSnapshot {
  const credentials: Credential[] = [];
  const read = (directory: string) => {
    const file = ['cheese-agent.config.json', 'super-agent.config.json'].map(name => join(directory, name)).find(existsSync);
    if (!file) return {};
    const visit = (value: any, path: string[] = []): any => {
      if (typeof value === 'string') {
        if (secretKey.test(path.at(-1) || '') && value) {
          const marker = `credential:${randomUUID()}`;
          credentials.push({ marker, file, path, directory });
          return marker;
        }
        const resolved = substitute(value, directory);
        return ['dataDir', 'docsDir', 'trackingFile'].includes(path.at(-1) || '') ? resolve(directory, resolved) : resolved;
      }
      if (Array.isArray(value)) return value.map((entry, index) => visit(entry, [...path, String(index)]));
      if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, visit(entry, [...path, key])]));
      return value;
    };
    return visit(JSON.parse(readFileSync(file, 'utf8')));
  };
  const values = CheeseAgentConfigSchema.parse(merge(read(commonDirectory), commonDirectory === workspace ? {} : read(workspace)));
  values.memory.dataDir = resolve(workspace, values.memory.dataDir);
  values.cron.dataDir = resolve(workspace, values.cron.dataDir);
  values.rag.docsDir = resolve(workspace, values.rag.docsDir);
  values.usage.trackingFile = resolve(workspace, values.usage.trackingFile);
  if (!values.model.apiKey && values.model.provider !== 'mock') {
    const names = values.model.provider === 'dashscope' ? ['DASHSCOPE_API_KEY', 'OPENAI_API_KEY'] : ['OPENAI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY'];
    const env = { ...environment(commonDirectory), ...environment(workspace) };
    const name = names.find(key => env[key]);
    if (name) {
      const marker = `credential:${randomUUID()}`;
      const directory = environment(workspace)[name] ? workspace : commonDirectory;
      credentials.push({ marker, env: name, directory });
      values.model.apiKey = marker;
    }
  }
  return { id: randomUUID(), values, credentials };
}

export function resolveConfig(snapshot: ConfigSnapshot): CheeseAgentConfig {
  const visit = (value: any): any => {
    if (typeof value === 'string') {
      const reference = snapshot.credentials.find(item => item.marker === value);
      if (!reference) return value;
      let secret: any;
      try {
        secret = reference.env ? environment(reference.directory)[reference.env] : reference.path!.reduce((current, key) => current?.[key], JSON.parse(readFileSync(reference.file!, 'utf8')));
        if (typeof secret !== 'string' || !secret) throw new Error();
        return substitute(secret, reference.directory);
      } catch { throw new Error('会话引用的凭据已缺失或不可用'); }
    }
    if (Array.isArray(value)) return value.map(visit);
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, visit(entry)]));
    return value;
  };
  return CheeseAgentConfigSchema.parse(visit(snapshot.values));
}
