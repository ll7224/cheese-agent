import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Executor } from './service.js';

export const executeWorker: Executor = ({ cwd, messages, config, emit, acquireChild }) => new Promise((resolve, reject) => {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const worker = fork(fileURLToPath(new URL(`./worker.${extension}`, import.meta.url)), [], {
    cwd, execArgv: extension === 'ts' ? ['--import', 'tsx'] : [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let failure = '';
  let result: typeof messages | undefined;
  let exited = false;
  const permits = new Map<string, () => void>();
  worker.stderr?.on('data', chunk => { failure = (failure + chunk.toString()).slice(-4000); });
  worker.on('message', (message: any) => {
    if (message.type === 'child-acquire') {
      void acquireChild(message.id).then(release => {
        if (exited) { release(); return; }
        permits.set(message.id, release);
        worker.send({ type: 'child-granted', id: message.id });
      }).catch(error => { failure = String(error); worker.kill(); });
    }
    if (message.type === 'child-release') { permits.get(message.id)?.(); permits.delete(message.id); }
    if (message.type === 'event') {
      try { emit?.(message.event); } catch (error) { failure = String(error); worker.kill(); }
    }
    if (message.type === 'result') result = message.messages;
    if (message.type === 'error') failure = message.error;
  });
  worker.on('error', reject);
  worker.on('exit', code => {
    exited = true;
    permits.forEach(release => release());
    result && code === 0 ? resolve(result) : reject(new Error(failure || `Agent 进程退出 (${code})`));
  });
  worker.send({ messages, config });
});
