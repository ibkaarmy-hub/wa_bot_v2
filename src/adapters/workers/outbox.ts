// src/adapters/workers/outbox.ts
import type { AuditLog, Clock, MessagingPort } from "../../core/ports.js";
import type { OutboundRow, PgOutbox } from "../postgres/repos.js";

export function backoffMs(attempt: number): number { return Math.min(attempt * attempt * 5000, 600_000); }

const STALE_SENDING_MS = 120_000;

export class OutboxWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private maxAttempts: number;
  private inFlight: Promise<unknown> | null = null;
  constructor(private d: { outbox: Pick<PgOutbox, "claimDue" | "markSent" | "markFailed" | "releaseStale">; messaging: MessagingPort; audit: AuditLog; clock: Clock; log: (msg: string, extra?: unknown) => void; maxAttempts?: number; onPermanentFailure?: (row: OutboundRow) => Promise<void> }) {
    this.maxAttempts = d.maxAttempts ?? 8;
  }

  async tick(): Promise<number> {
    const releaseCount = await this.d.outbox.releaseStale(new Date(this.d.clock.now().getTime() - STALE_SENDING_MS));
    if (releaseCount > 0) this.d.log("released stale sending rows", { count: releaseCount });
    const rows = await this.d.outbox.claimDue(20, this.d.clock.now());
    for (const r of rows) {
      try {
        const res = r.kind === "text"
          ? await this.d.messaging.sendText(r.to, r.body ?? "")
          : await this.d.messaging.sendTemplate(r.to, r.template ?? "", r.params ?? []);
        await this.d.outbox.markSent(r.id, res.id);
      } catch (e) {
        const err = e as { message?: string; retryable?: boolean };
        const retry = err.retryable === true && r.attempts < this.maxAttempts;
        const next = retry ? new Date(this.d.clock.now().getTime() + backoffMs(r.attempts)) : null;
        await this.d.outbox.markFailed(r.id, String(err.message ?? e), next);
        this.d.log(retry ? "outbound retry scheduled" : "outbound failed permanently", { rowId: r.id, conversationId: r.conversationId, error: String(err.message ?? e) });
        if (!retry) {
          await this.d.audit.record({ conversationId: r.conversationId ?? undefined, type: "outbound_failed_permanently", data: { id: r.id, to: r.to, error: String(err.message ?? e) } });
          if (this.d.onPermanentFailure) {
            try { await this.d.onPermanentFailure(r); }
            catch (e2) { this.d.log("onPermanentFailure error", { rowId: r.id, error: String(e2) }); }
          }
        }
      }
    }
    return rows.length;
  }

  start(intervalMs = 500) {
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.inFlight = this.tick()
        .catch(e => { this.d.log("outbox tick error", { error: String(e) }); })
        .finally(() => { this.running = false; });
    }, intervalMs);
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }
}
