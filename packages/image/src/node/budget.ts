/**
 * Admits work by the memory it needs. A task starts when its estimate fits next to the tasks already running,
 * or when nothing else is running (an estimate above the limit is clamped to it, so one big task still runs,
 * alone). Keeps a pool of parallel decodes from adding up to more than the budget.
 */
export class MemoryBudget {
  private used = 0;
  private waiting: Array<() => void> = [];

  constructor(readonly limit: number) {}

  async run<T>(bytes: number, task: () => Promise<T>): Promise<T> {
    const need = Math.min(Math.max(0, bytes), this.limit);
    while (this.used > 0 && this.used + need > this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.used += need;
    try {
      return await task();
    } finally {
      this.used -= need;
      const wake = this.waiting;
      this.waiting = [];
      for (const resume of wake) resume();
    }
  }
}
