/** Time only moves when a test advances it; sleeping instances wake in order. */
export class VirtualClock {
  private current = 0;
  private timers: { at: number; wake: () => void }[] = [];

  now = (): number => this.current;

  sleep = (ms: number): Promise<void> =>
    new Promise((wake) => this.timers.push({ at: this.current + ms, wake }));

  async advance(ms: number): Promise<void> {
    const end = this.current + ms;
    for (;;) {
      await flush();
      const due = this.timers
        .filter((timer) => timer.at <= end)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.current = Math.max(this.current, due.at);
      due.wake();
    }
    this.current = end;
    await flush();
  }
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
}
