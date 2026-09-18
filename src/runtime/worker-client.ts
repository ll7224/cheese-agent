import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Executor } from './service.js';

export const executeWorker: Executor = ({ cwd, messages, config, emit }) => new Promise((resolve, reject) => {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const worker = fork(fileURLToPath(new URL(`./worker.${extension}`, import.meta.url)), [], {
    cwd, execArgv: extension === 'ts' ? ['--import', 'tsx'] : [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let failure = '';
  let result: typeof messages | undefined;
  worker.stderr?.on('data', chunk => { failure = (failure + chunk.toString()).slice(-4000); });
  worker.on('message', (message: any) => {
    if (message.type === 'event') {
      try { emit?.(message.event); } catch (error) { failure = String(error); worker.kill(); }
    }
    if (message.type === 'result') result = message.messages;
    if (message.type === 'error') failure = message.error;
  });
  worker.on('error', reject);
  worker.on('exit', code => result && code === 0 ? resolve(result) : reject(new Error(failure || `Agent 进程退出 (${code})`)));
  worker.send({ messages, config });
});
