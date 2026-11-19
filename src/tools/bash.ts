import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { truncateResult, type ToolDefinition } from './registry.js';

export interface CommandEvidence {
  executionId: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  timestamp: string;
}

/**
 * 构造支持执行证据记录的 bash 工具
 */
export function createBashTool(
  onEvidence?: (evidence: CommandEvidence) => void,
  cwd?: string
): ToolDefinition {
  return {
    name: 'bash',
    description: '执行 shell 命令并返回输出。默认10秒超时；构建或测试可通过 timeoutMs 显式延长，最多300秒',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 300000, description: '超时毫秒数，默认10000；构建或测试建议120000' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
    isReadOnly: false,
    maxResultChars: 3000,
    execute: async ({ command, timeoutMs = 10000 }: { command: string; timeoutMs?: number }) => {
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
        throw new Error('timeoutMs 必须为1到300000之间的整数');
      }
      const executionId = randomUUID();
      const currentCwd = cwd || process.cwd();
      const timestamp = new Date().toISOString();

      try {
        execSync('echo test', { stdio: 'ignore' });
      } catch {
        return `[bash 不可用] 当前 Sandbox 不支持 shell 命令。本地终端运行 pnpm start 可使用 bash 工具。`;
      }

      try {
        const output = execSync(command, {
          cwd: currentCwd,
          encoding: 'utf-8',
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (onEvidence) {
          onEvidence({
            executionId,
            command,
            cwd: currentCwd,
            exitCode: 0,
            timedOut: false,
            stdout: output || '',
            stderr: '',
            timestamp,
          });
        }

        return output || '(命令执行成功，无输出)';
      } catch (err: any) {
        const stderr = err.stderr ? String(err.stderr) : '';
        const stdout = err.stdout ? String(err.stdout) : '';
        const timedOut = err.code === 'ETIMEDOUT' || Boolean(err.killed && err.signal === 'SIGTERM');
        const exitCode = typeof err.status === 'number' ? err.status : null;

        if (onEvidence) {
          onEvidence({
            executionId,
            command,
            cwd: currentCwd,
            exitCode,
            timedOut,
            stdout,
            stderr,
            timestamp,
          });
        }

        // Reserve room for both streams before the registry applies its global limit.
        // A warning on stderr must not hide an assertion failure on stdout.
        const streams = [
          ...(stdout ? [{ name: 'stdout', text: stdout }] : []),
          ...(stderr ? [{ name: 'stderr', text: stderr }] : []),
        ];
        const budget = Math.floor(2800 / Math.max(1, streams.length));
        const details = streams.length === 1 ? streams[0].text : streams.map(stream =>
          `[${stream.name}]\n${truncateResult(stream.text, budget)}`
        ).join('\n');
        return `命令执行失败 (exit ${exitCode ?? 'killed'}):\n${details || err.message}`;
      }
    },
  };
}

export const bashTool = createBashTool();
