export class Scheduler {
  private stopped = true;
  private timer?: ReturnType<typeof setTimeout>;
  private running: Promise<void> = Promise.resolve();
  constructor(
    private readonly work: () => Promise<void>,
    private readonly interval = 1000,
  ) {}
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = () => {
      if (this.stopped) return;
      this.running = this.work()
        .catch(() => {})
        .finally(() => {
          if (!this.stopped) this.timer = setTimeout(tick, this.interval);
        });
    };
    tick();
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }
}
