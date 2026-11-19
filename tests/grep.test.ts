import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grepTool } from '../src/tools/index.js';

test('grep skips generated caches before they can consume the source match limit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cheese-grep-cache-'));
  try {
    for (const cache of ['.next', '.cache']) {
      mkdirSync(join(root, cache));
      writeFileSync(join(root, cache, 'cache.txt'), 'cmdk-group GENERATED\n'.repeat(60));
    }
    writeFileSync(join(root, 'source.test.ts'), 'first line\nconst selector = "cmdk-group SOURCE";\n');
    const result = String(await grepTool.execute({ pattern: 'cmdk-group', path: root }));
    assert.match(result, /source\.test\.ts:2: const selector = "cmdk-group SOURCE";/);
    assert.doesNotMatch(result, /GENERATED|结果已截断/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('grep excludes binary contents even when the file extension is unfamiliar', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cheese-grep-binary-'));
  try {
    writeFileSync(join(root, 'nul.pack'), Buffer.from('\0cmdk-group BINARY_NUL'));
    writeFileSync(join(root, 'invalid.blob'), Buffer.concat([Buffer.from([0xff]), Buffer.from('cmdk-group BINARY_INVALID')]));
    writeFileSync(join(root, '.projectrc'), 'cmdk-group 中文配置\n');
    const result = String(await grepTool.execute({ pattern: 'cmdk-group', path: root }));
    assert.match(result, /\.projectrc:1: cmdk-group 中文配置/);
    assert.doesNotMatch(result, /BINARY|\u0000|\ufffd/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('grep preserves explicit text-file searches including a file inside a generated directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cheese-grep-explicit-'));
  try {
    mkdirSync(join(root, '.next'));
    const file = join(root, '.next', 'diagnostic.log');
    writeFileSync(file, 'before\nDiagnostic FOUND\n');
    assert.equal(await grepTool.execute({ pattern: 'diagnostic', path: file }), ':2: Diagnostic FOUND');
    assert.equal(await grepTool.execute({ pattern: 'missing', path: file }), '没有找到匹配 "missing" 的内容');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
