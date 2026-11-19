import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import type { ToolDefinition } from './registry.js';

const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', '.next', '.cache']);
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.gif', '.woff', '.woff2', '.ico', '.lock']);

export const grepTool: ToolDefinition = {
  name: 'grep',
  description: '在文本文件中搜索正则表达式，返回行号和内容。目录遍历跳过依赖、构建缓存和二进制；可指定文件直接搜索',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索模式（正则表达式）' },
      path: { type: 'string', description: '搜索路径（文件或目录），默认当前目录' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  execute: async ({ pattern, path = '.' }: { pattern: string; path?: string }) => {
    const baseDir = resolve(path);
    const regex = new RegExp(pattern, 'i');
    const matches: string[] = [];
    const decoder = new TextDecoder('utf-8', { fatal: true });

    function searchFile(filePath: string) {
      if (matches.length >= 50 || BINARY_EXTENSIONS.has(extname(filePath).toLowerCase())) return;
      let content: string;
      try {
        const bytes = readFileSync(filePath);
        if (bytes.includes(0)) return;
        content = decoder.decode(bytes);
      } catch { return; }

      const lines = content.split('\n');
      const rel = relative(baseDir, filePath);
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push(`${rel}:${i + 1}: ${lines[i].trimEnd()}`);
          if (matches.length >= 50) return;
        }
      }
    }

    function walk(dir: string) {
      if (matches.length >= 50) return;
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return; }
      for (const name of entries) {
        if (SKIP_DIRECTORIES.has(name)) continue;
        const full = join(dir, name);
        try {
          if (statSync(full).isDirectory()) walk(full);
          else searchFile(full);
        } catch { /* skip unreadable entries */ }
      }
    }

    if (statSync(baseDir).isFile()) searchFile(baseDir);
    else walk(baseDir);

    if (matches.length === 0) return `没有找到匹配 "${pattern}" 的内容`;
    const suffix = matches.length >= 50 ? '\n... (结果已截断，共 50+ 条匹配)' : '';
    return matches.join('\n') + suffix;
  },
};
