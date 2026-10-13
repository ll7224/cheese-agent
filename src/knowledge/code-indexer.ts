import ts from 'typescript';
import path from 'node:path';
import fs from 'node:fs';
import type { CodeIndex, EntityDraft, EdgeDraft, SourceSpan } from './types.js';

/**
 * 根据文件扩展名确定 TypeScript ScriptKind
 */
function getScriptKind(filePath: string): ts.ScriptKind {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts':
      return ts.ScriptKind.TS;
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.js':
      return ts.ScriptKind.JS;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.Unknown;
  }
}

/**
 * 加载工作区 tsconfig.json 中的 CompilerOptions（若存在）
 */
function loadCompilerOptions(workspaceRoot?: string): ts.CompilerOptions {
  if (!workspaceRoot) {
    return { moduleResolution: ts.ModuleResolutionKind.Node10 };
  }
  try {
    const tsconfigPath = ts.findConfigFile(workspaceRoot, ts.sys.fileExists, 'tsconfig.json');
    if (tsconfigPath) {
      const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
      if (configFile.config) {
        const parsed = ts.parseJsonConfigFileContent(
          configFile.config,
          ts.sys,
          path.dirname(tsconfigPath)
        );
        return parsed.options;
      }
    }
  } catch {}
  return { moduleResolution: ts.ModuleResolutionKind.Node10 };
}

/**
 * 解析 import 语句的目标路径或包名
 */
function resolveImportSpecifier(
  specifier: string,
  importingRelPath: string,
  workspaceRoot?: string
): { targetRelPath: string; isPackage: boolean; packageName?: string } {
  // 1. 如果不是以 . 或 / 开头，检查是否通过 tsconfig 路径别名映射到了工作区内部文件
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    if (workspaceRoot) {
      try {
        const host = ts.createCompilerHost({});
        const containingFile = path.resolve(workspaceRoot, importingRelPath);
        const options = loadCompilerOptions(workspaceRoot);
        const resolved = ts.resolveModuleName(specifier, containingFile, options, host);
        if (resolved.resolvedModule && !resolved.resolvedModule.isExternalLibraryImport) {
          const resolvedFile = resolved.resolvedModule.resolvedFileName;
          const targetRel = path.relative(workspaceRoot, resolvedFile).replace(/\\/g, '/');
          return { targetRelPath: targetRel, isPackage: false };
        }
      } catch {}
    }
    // 纯外部包导入（如 'lodash', 'better-sqlite3'）
    return { targetRelPath: specifier, isPackage: true, packageName: specifier };
  }

  // 2. 相对路径导入
  const containingDir = path.dirname(importingRelPath);
  let resolvedRelative = path.normalize(path.join(containingDir, specifier)).replace(/\\/g, '/');
  if (resolvedRelative.startsWith('./')) {
    resolvedRelative = resolvedRelative.slice(2);
  }

  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.d.ts', '/index.ts', '/index.js'];
  if (workspaceRoot) {
    const absBase = path.resolve(workspaceRoot, resolvedRelative);
    if (fs.existsSync(absBase) && fs.statSync(absBase).isFile()) {
      return { targetRelPath: resolvedRelative, isPackage: false };
    }
    if (resolvedRelative.endsWith('.js')) {
      const tsCandidate = resolvedRelative.slice(0, -3) + '.ts';
      if (fs.existsSync(path.resolve(workspaceRoot, tsCandidate))) {
        return { targetRelPath: tsCandidate, isPackage: false };
      }
      const tsxCandidate = resolvedRelative.slice(0, -3) + '.tsx';
      if (fs.existsSync(path.resolve(workspaceRoot, tsxCandidate))) {
        return { targetRelPath: tsxCandidate, isPackage: false };
      }
    }
    for (const ext of extensions) {
      const candidate = absBase + ext;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        const candidateRel = path.relative(workspaceRoot, candidate).replace(/\\/g, '/');
        return { targetRelPath: candidateRel, isPackage: false };
      }
    }
  } else {
    if (resolvedRelative.endsWith('.js')) {
      resolvedRelative = resolvedRelative.slice(0, -3) + '.ts';
    } else if (!path.extname(resolvedRelative)) {
      resolvedRelative = resolvedRelative + '.ts';
    }
  }

  return { targetRelPath: resolvedRelative, isPackage: false };
}

/**
 * 语法解析 TS/TSX/JS/JSX 源码，提取结构实体与关联边。
 * 实体 key: `${workspaceId}:${path}:${container}:${kind}:${name}`
 */
export function indexCode(
  workspaceId: string,
  filePath: string,
  content: string,
  workspaceRoot?: string
): CodeIndex {
  const scriptKind = getScriptKind(filePath);
  if (scriptKind === ts.ScriptKind.Unknown) {
    return { entities: [], edges: [] };
  }

  const normalizedRelPath = filePath.replace(/\\/g, '/');
  const fileName = path.basename(normalizedRelPath);
  const sf = ts.createSourceFile(normalizedRelPath, content, ts.ScriptTarget.Latest, true, scriptKind);

  const entities: EntityDraft[] = [];
  const edges: EdgeDraft[] = [];

  function getSpan(node: ts.Node): SourceSpan {
    const start = node.getStart(sf);
    const end = node.getEnd();
    const startLine = sf.getLineAndCharacterOfPosition(start).line + 1;
    const endLine = sf.getLineAndCharacterOfPosition(Math.max(start, end - 1)).line + 1;
    return { startOffset: start, endOffset: end, startLine, endLine };
  }

  // 1. 创建文件根实体
  const fileEntityId = `${workspaceId}:${normalizedRelPath}:::file:${fileName}`;
  const fileSpan: SourceSpan = {
    startOffset: 0,
    endOffset: content.length,
    startLine: 1,
    endLine: sf.getLineAndCharacterOfPosition(Math.max(0, content.length - 1)).line + 1,
  };
  entities.push({
    id: fileEntityId,
    workspaceId,
    path: normalizedRelPath,
    container: undefined,
    kind: 'file',
    name: fileName,
    span: fileSpan,
  });

  function recordSupportedDeclaration(node: ts.Node, span: SourceSpan): void {
    // 2. 函数声明
    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.text;
      const id = `${workspaceId}:${normalizedRelPath}::function:${name}`;
      entities.push({
        id,
        workspaceId,
        path: normalizedRelPath,
        container: undefined,
        kind: 'function',
        name,
        span,
      });
      edges.push({
        id: `${fileEntityId}->${id}:contains`,
        sourceEntityId: fileEntityId,
        targetEntityId: id,
        kind: 'contains',
        span,
      });
      return;
    }

    // 3. 类声明及类成员
    if (ts.isClassDeclaration(node) && node.name) {
      const className = node.name.text;
      const classId = `${workspaceId}:${normalizedRelPath}::class:${className}`;
      entities.push({
        id: classId,
        workspaceId,
        path: normalizedRelPath,
        container: undefined,
        kind: 'class',
        name: className,
        span,
      });
      edges.push({
        id: `${fileEntityId}->${classId}:contains`,
        sourceEntityId: fileEntityId,
        targetEntityId: classId,
        kind: 'contains',
        span,
      });

      // 类成员
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && member.name) {
          const methodName = member.name.getText(sf);
          const methodSpan = getSpan(member);
          const methodId = `${workspaceId}:${normalizedRelPath}:${className}:function:${methodName}`;
          entities.push({
            id: methodId,
            workspaceId,
            path: normalizedRelPath,
            container: className,
            kind: 'function',
            name: methodName,
            span: methodSpan,
          });
          edges.push({
            id: `${classId}->${methodId}:contains`,
            sourceEntityId: classId,
            targetEntityId: methodId,
            kind: 'contains',
            span: methodSpan,
          });
        } else if (ts.isPropertyDeclaration(member) && member.name) {
          const propName = member.name.getText(sf);
          const propSpan = getSpan(member);
          const propId = `${workspaceId}:${normalizedRelPath}:${className}:variable:${propName}`;
          entities.push({
            id: propId,
            workspaceId,
            path: normalizedRelPath,
            container: className,
            kind: 'variable',
            name: propName,
            span: propSpan,
          });
          edges.push({
            id: `${classId}->${propId}:contains`,
            sourceEntityId: classId,
            targetEntityId: propId,
            kind: 'contains',
            span: propSpan,
          });
        }
      }
      return;
    }

    // 4. 接口声明
    if (ts.isInterfaceDeclaration(node)) {
      const name = node.name.text;
      const id = `${workspaceId}:${normalizedRelPath}::interface:${name}`;
      entities.push({
        id,
        workspaceId,
        path: normalizedRelPath,
        container: undefined,
        kind: 'interface',
        name,
        span,
      });
      edges.push({
        id: `${fileEntityId}->${id}:contains`,
        sourceEntityId: fileEntityId,
        targetEntityId: id,
        kind: 'contains',
        span,
      });
      return;
    }

    // 5. 类型别名声明
    if (ts.isTypeAliasDeclaration(node)) {
      const name = node.name.text;
      const id = `${workspaceId}:${normalizedRelPath}::type:${name}`;
      entities.push({
        id,
        workspaceId,
        path: normalizedRelPath,
        container: undefined,
        kind: 'type',
        name,
        span,
      });
      edges.push({
        id: `${fileEntityId}->${id}:contains`,
        sourceEntityId: fileEntityId,
        targetEntityId: id,
        kind: 'contains',
        span,
      });
      return;
    }

    // 6. 顶级变量与命名箭头函数声明
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const varName = decl.name.text;
          const varSpan = getSpan(decl);
          const isFn =
            decl.initializer &&
            (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer));
          const kind = isFn ? 'function' : 'variable';
          const varId = `${workspaceId}:${normalizedRelPath}::${kind}:${varName}`;
          entities.push({
            id: varId,
            workspaceId,
            path: normalizedRelPath,
            container: undefined,
            kind,
            name: varName,
            span: varSpan,
          });
          edges.push({
            id: `${fileEntityId}->${varId}:contains`,
            sourceEntityId: fileEntityId,
            targetEntityId: varId,
            kind: 'contains',
            span: varSpan,
          });
        }
      }
      return;
    }

    // 7. 静态 import 语句
    if (ts.isImportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        const resolved = resolveImportSpecifier(specifier, normalizedRelPath, workspaceRoot);

        let targetId: string;
        if (resolved.isPackage) {
          const pkgName = resolved.packageName || specifier;
          targetId = `${workspaceId}:::package:${pkgName}`;
          // 记录 package 实体
          if (!entities.some((e) => e.id === targetId)) {
            entities.push({
              id: targetId,
              workspaceId,
              path: pkgName,
              container: undefined,
              kind: 'package',
              name: pkgName,
              span,
            });
          }
        } else {
          const targetRel = resolved.targetRelPath;
          const targetBase = path.basename(targetRel);
          targetId = `${workspaceId}:${targetRel}:::file:${targetBase}`;
          // 记录目标 file 实体存根
          if (!entities.some((e) => e.id === targetId)) {
            entities.push({
              id: targetId,
              workspaceId,
              path: targetRel,
              container: undefined,
              kind: 'file',
              name: targetBase,
              span: { startOffset: 0, endOffset: 0, startLine: 1, endLine: 1 },
            });
          }
        }

        // 文件间导入关系边
        edges.push({
          id: `${fileEntityId}->${targetId}:imports`,
          sourceEntityId: fileEntityId,
          targetEntityId: targetId,
          kind: 'imports',
          span,
        });

        // 若有具体具名导入，也记录符号级别边
        if (
          !resolved.isPackage &&
          node.importClause?.namedBindings &&
          ts.isNamedImports(node.importClause.namedBindings)
        ) {
          for (const elem of node.importClause.namedBindings.elements) {
            const symName = (elem.propertyName || elem.name).text;
            const symTargetId = `${workspaceId}:${resolved.targetRelPath}::function:${symName}`;
            edges.push({
              id: `${fileEntityId}->${symTargetId}:imports`,
              sourceEntityId: fileEntityId,
              targetEntityId: symTargetId,
              kind: 'imports',
              span,
            });
          }
        }
      }
      return;
    }

    // 8. 静态 export-from 语句
    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        const resolved = resolveImportSpecifier(specifier, normalizedRelPath, workspaceRoot);
        const targetId = resolved.isPackage
          ? `${workspaceId}:::package:${resolved.packageName || specifier}`
          : `${workspaceId}:${resolved.targetRelPath}:::file:${path.basename(resolved.targetRelPath)}`;

        edges.push({
          id: `${fileEntityId}->${targetId}:exports`,
          sourceEntityId: fileEntityId,
          targetEntityId: targetId,
          kind: 'exports',
          span,
        });
      }
      return;
    }
  }

  function visit(node: ts.Node): void {
    const span = getSpan(node);
    recordSupportedDeclaration(node, span);
    ts.forEachChild(node, visit);
  }

  visit(sf);

  return { entities, edges };
}
