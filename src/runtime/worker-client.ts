import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Executor } from './service.js';

export const executeWorker: Executor = ({ cwd, messages, config, activeSkills, emit, acquireChild, manageCron, signal }) => new Promise((resolve, reject) => {
  signal?.throwIfAborted();
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const worker = fork(fileURLToPath(new URL(`./worker.${extension}`, import.meta.url)), [], {
    cwd, detached: process.platform !== 'win32', execArgv: extension === 'ts' ? ['--import', import.meta.resolve('tsx')] : [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let failure = '';
  let result: typeof messages | undefined;
  let exited = false;
  const permits = new Map<string, () => void>();
  let terminateTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (name: NodeJS.Signals) => {
    try {
      if (process.platform !== 'win32' && worker.pid) process.kill(-worker.pid, name);
      else worker.kill(name);
    } catch (error: any) { if (error.code !== 'ESRCH') failure = error.message; }
  };
  const abort = () => {
    if (worker.connected) worker.send({ type: 'abort' });
    terminateTimer = setTimeout(() => kill('SIGTERM'), 1000);
    killTimer = setTimeout(() => kill('SIGKILL'), 2000);
  };
  signal?.addEventListener('abort', abort, { once: true });
  worker.stderr?.on('data', chunk => { failure = (failure + chunk.toString()).slice(-4000); });
  worker.on('message', (message: any) => {
    if (message.type === 'cron') {
      void Promise.resolve().then(() => { signal.throwIfAborted(); return manageCron(message.input); }).then(
        output => { if (worker.connected) worker.send({ type: 'cron-result', id: message.id, output }); },
        error => { if (worker.connected) worker.send({ type: 'cron-result', id: message.id, error: String(error) }); },
      );
    }
    if (message.type === 'child-acquire') {
      void acquireChild(message.id).then(release => {
        if (exited || signal?.aborted) { release(); return; }
        permits.set(message.id, release);
        worker.send({ type: 'child-granted', id: message.id });
      }).catch(error => { failure = String(error); if (worker.connected) worker.send({ type: 'child-denied', id: message.id }); });
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
    clearTimeout(terminateTimer); clearTimeout(killTimer);
    signal?.removeEventListener('abort', abort);
    kill('SIGKILL');
    permits.forEach(release => release());
    result && code === 0 ? resolve(result) : reject(new Error(failure || `Agent 进程退出 (${code})`));
  });
  worker.send({ messages, config, activeSkills });
});
