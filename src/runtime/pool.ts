export class Pool {
  active = 0;
  private waiting: Array<() => void> = [];
  constructor(readonly limit = 3) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('并发额度必须为正整数');
  }
  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.active >= this.limit) await new Promise<void>((resolve, reject) => {
      const ready = () => { signal?.removeEventListener('abort', abort); resolve(); };
      const abort = () => { this.waiting = this.waiting.filter(item => item !== ready); reject(signal?.reason); };
      this.waiting.push(ready);
      signal?.addEventListener('abort', abort, { once: true });
    });
    else this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    };
  }
}
