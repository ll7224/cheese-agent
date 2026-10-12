import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireServiceLock } from '../src/runtime/service-lock.js';

test('a crashed owner is recovered automatically without touching session data', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cheese-crashed-lock-'));
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', `
    import { acquireServiceLock } from ${JSON.stringify(new URL('../src/runtime/service-lock.ts', import.meta.url).href)};
    acquireServiceLock(process.argv[1]);
    process.send('locked');
    setInterval(() => {}, 1000);
  `, directory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  try {
    await once(child, 'message');
    assert.throws(() => acquireServiceLock(directory), /正在使用/);
    const exited = once(child, 'exit');
    child.kill('SIGKILL'); await exited;
    writeFileSync(join(directory, 'state.json'), 'preserve exactly');
    const release = acquireServiceLock(directory);
    assert.equal(JSON.parse(readFileSync(join(directory, 'service.lock'), 'utf8')).pid, process.pid);
    assert.equal(readFileSync(join(directory, 'state.json'), 'utf8'), 'preserve exactly');
    assert.throws(() => acquireServiceLock(directory), /正在使用/);
    release();
    acquireServiceLock(directory)();
  } finally { child.kill('SIGKILL'); rmSync(directory, { recursive: true, force: true }); }
});

test('unreadable legacy ownership is retained instead of guessed stale', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cheese-invalid-lock-'));
  try {
    writeFileSync(join(directory, 'service.lock'), 'broken');
    assert.throws(() => acquireServiceLock(directory), /锁/);
    assert.equal(readFileSync(join(directory, 'service.lock'), 'utf8'), 'broken');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a live legacy owner without a database lock still blocks startup', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cheese-legacy-lock-'));
  const owner = JSON.stringify({ pid: process.pid, token: 'legacy-owner' });
  try {
    writeFileSync(join(directory, 'service.lock'), owner);
    assert.throws(() => acquireServiceLock(directory), /正在使用/);
    assert.equal(readFileSync(join(directory, 'service.lock'), 'utf8'), owner);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
