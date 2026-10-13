import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from './registry.js';

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
    description: '执行 shell 命令并返回输出。适合运行脚本、检查环境、执行构建等操作',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
    isReadOnly: false,
    maxResultChars: 3000,
    execute: async ({ command }: { command: string }) => {
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
          timeout: 10000,
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
        const timedOut = Boolean(err.killed && err.signal === 'SIGTERM');
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

        return `命令执行失败 (exit ${exitCode ?? 'killed'}):\n${stderr || stdout || err.message}`;
      }
    },
  };
}

export const bashTool = createBashTool();
