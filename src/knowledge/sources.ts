import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import type { KnowledgeContext, SourceProposal } from './types.js';

export const MAX_FILE_SIZE_BYTES = 1024 * 1024; // 1 MiB

export const IGNORE_PATTERNS = [
  '**/.git/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/coverage/**',
  '**/.cheese-knowledge/**',
  '**/.env*',
  '**/*.pem',
  '**/*.key',
  '**/id_rsa*',
  '**/*token*',
  '**/*secret*',
];

/**
 * 检查指定相对或绝对路径是否属于应当忽略的文件（凭据、中间构件、版本库元数据等）
 */
export function isIgnoredKnowledgePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const baseName = path.basename(normalized);

  if (
    baseName === '.git' ||
    baseName === 'node_modules' ||
    baseName === 'dist' ||
    baseName === 'coverage' ||
    baseName === '.cheese-knowledge'
  ) {
    return true;
  }

  if (baseName.startsWith('.env')) {
    return true;
  }

  const lower = baseName.toLowerCase();
  if (
    lower.endsWith('.pem') ||
    lower.endsWith('.key') ||
    lower.startsWith('id_rsa') ||
    lower.includes('token') ||
    lower.includes('secret')
  ) {
    return true;
  }

  const parts = normalized.split('/');
  for (const part of parts) {
    if (
      part === '.git' ||
      part === 'node_modules' ||
      part === 'dist' ||
      part === 'coverage' ||
      part === '.cheese-knowledge'
    ) {
      return true;
    }
  }

  return false;
}

/**
 * 在目标工作区中发现候选本地知识来源与依赖库建议。
 * 遵循严格实路径检查、符号链接不跟随、1 MiB 文件大小门限与安全过滤。
 */
export async function discoverWorkspaceSources(
  ctx: KnowledgeContext
): Promise<SourceProposal[]> {
  const root = ctx.workspacePath;
  if (!fs.existsSync(root)) return [];

  const realRoot = fs.realpathSync(root);
  const proposals: SourceProposal[] = [];

  const patterns = [
    'README*',
    'docs/**/*',
    'src/**/*',
    'AGENT*',
    '.agents/**/*',
    'package.json',
    'pnpm-lock.yaml',
  ];

  const entries = await fg(patterns, {
    cwd: realRoot,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: IGNORE_PATTERNS,
  });

  const projectLibId = `project:${ctx.workspaceId}`;

  for (const rel of entries) {
    if (isIgnoredKnowledgePath(rel)) continue;

    const fullPath = path.join(realRoot, rel);
    try {
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;

      if (stat.size > MAX_FILE_SIZE_BYTES) {
        // 超限文件跳过，不伪装完整导入
        continue;
      }

      const id = `src-local-${rel.replace(/[^a-zA-Z0-9]/g, '_')}`;
      proposals.push({
        id,
        sourceId: id,
        libraryId: projectLibId,
        kind: 'local',
        locator: rel,
        enabled: false,
        reason: `Discovered local file: ${rel}`,
        syncStatus: 'ready',
      });
    } catch {
      // 访问受限或已删除，安全跳过
    }
  }

  // 分析 package.json 依赖
  const pkgPath = path.join(realRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const [depName, version] of Object.entries(allDeps)) {
        if (typeof version !== 'string') continue;
        const id = `src-dep-${depName.replace(/[^a-zA-Z0-9]/g, '_')}`;
        proposals.push({
          id,
          sourceId: id,
          libraryId: projectLibId,
          kind: 'managed',
          locator: `pkg:${depName}@${version}`,
          enabled: false,
          versionConstraint: version,
          reason: `Package dependency: ${depName}@${version}`,
          syncStatus: 'ready',
        });
      }
    } catch {}
  }

  return proposals;
}
