import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBashTool, type CommandEvidence } from '../src/tools/bash.js';
import { ToolRegistry } from '../src/tools/registry.js';

test('bash returns assertion stdout even when a failing command also writes a stderr warning', async () => {
  const events: CommandEvidence[] = [];
  const tool = createBashTool(event => events.push(event));
  const output = String(await tool.execute({
    command: "printf 'ASSERTION FAILED: expected high, received low\\n'; printf 'Browserslist warning\\n' >&2; exit 1",
  }));
  assert.match(output, /命令执行失败 \(exit 1\)/);
  assert.match(output, /ASSERTION FAILED: expected high, received low/);
  assert.match(output, /Browserslist warning/);
  assert.equal(events[0].stdout, 'ASSERTION FAILED: expected high, received low\n');
  assert.equal(events[0].stderr, 'Browserslist warning\n');
});

test('bash keeps diagnostics from both large streams within the model-facing result limit', async () => {
  const registry = new ToolRegistry();
  registry.register(createBashTool());
  const script = 'process.stdout.write("x".repeat(10000)+"\\nASSERTION FAILED\\n"); process.stderr.write("y".repeat(10000)+"\\nSTDERR DIAGNOSTIC\\n"); process.exit(2)';
  const output = String(await registry.toAISDKFormat().bash.execute({
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
  }));
  assert.match(output, /exit 2/);
  assert.match(output, /ASSERTION FAILED/);
  assert.match(output, /STDERR DIAGNOSTIC/);
  assert.ok(output.length <= 3000, `result too large: ${output.length}`);
});

test('bash preserves the command-only entry point and records short explicit timeouts', async () => {
  const events: CommandEvidence[] = [];
  const tool = createBashTool(event => events.push(event));
  assert.equal(await tool.execute({ command: 'printf ready' }), 'ready');
  const output = await tool.execute({ command: 'sleep 0.3; printf late', timeoutMs: 50 });
  assert.match(String(output), /命令执行失败/);
  assert.equal(events.at(-1)?.timedOut, true);
  assert.equal(events.at(-1)?.exitCode, null);
});

test('bash can complete a build-style command beyond the old ten-second limit', async () => {
  const events: CommandEvidence[] = [];
  const tool = createBashTool(event => events.push(event));
  const command = `${JSON.stringify(process.execPath)} -e 'setTimeout(() => console.log("finished"), 10200)'`;
  assert.equal(await tool.execute({ command, timeoutMs: 15000 }), 'finished\n');
  assert.equal(events.at(-1)?.exitCode, 0);
  assert.equal(events.at(-1)?.timedOut, false);
});

test('bash rejects unbounded and invalid timeout requests before executing', async () => {
  const tool = createBashTool();
  for (const timeoutMs of [0, -1, 1.5, 300001]) {
    await assert.rejects(tool.execute({ command: 'printf invalid', timeoutMs }), /timeoutMs/);
  }
});
