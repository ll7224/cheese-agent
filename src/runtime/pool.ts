export class Pool {
  active = 0;
  private waiting: Array<() => void> = [];
  constructor(readonly limit = 3) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('并发额度必须为正整数');
  }
  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) await new Promise<void>(resolve => this.waiting.push(resolve));
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
