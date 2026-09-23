// src/adapters/workers/relay.ts
// Drives DoctorRelay.tick() on an interval. Same shape as OutboxWorker: no overlapping ticks, awaits the in-flight tick on stop.
export class RelayWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight: Promise<unknown> | null = null;
  constructor(private d: { relay: { tick(): Promise<void> }; log: (msg: string, extra?: unknown) => void }) {}

  start(intervalMs: number) {
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.inFlight = this.d.relay.tick()
        .catch(e => { this.d.log("relay tick error", { error: String(e) }); })
        .finally(() => { this.running = false; });
    }, intervalMs);
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }
}
