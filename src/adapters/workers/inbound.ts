// src/adapters/workers/inbound.ts
import type { Engine } from "../../core/services/engine.js";
import type { DoctorRelay } from "../../core/services/relay/index.js";
import { normalisePhone } from "../../core/lib/phone.js";
import type { AuditLog, ConversationLock } from "../../core/ports.js";
import type { ParsedEvent } from "../meta/parse.js";

interface EventStore { insertIfNew(id: string, payload: unknown): Promise<boolean>; markProcessed(id: string): Promise<void>; }

export class InboundWorker implements ConversationLock {
  private chains = new Map<string, Promise<void>>();
  private pending = new Set<Promise<void>>();
  constructor(private d: {
    engine: Pick<Engine, "handlePatientMessage" | "handleDoctorEcho">;
    relay: Pick<DoctorRelay, "handleDoctorMessage">;
    doctorPhones: Set<string>;                       // E.164 roster numbers; messages from them go to the relay
    events: EventStore; audit: AuditLog; log: (msg: string, extra?: unknown) => void;
  }) {}

  async accept(events: ParsedEvent[], rawPayload: unknown): Promise<void> {
    for (const ev of events) {
      if (ev.type === "ignored") { await this.d.audit.record({ type: "event_ignored", data: { reason: ev.reason } }); continue; }
      if (ev.type === "status") { await this.d.audit.record({ type: "delivery_status", data: { externalId: ev.externalId, status: ev.status } }); continue; }
      const id = ev.type === "patient_message" ? ev.message.externalId : ev.echo.externalId;
      const phone = normalisePhone(ev.type === "patient_message" ? ev.message.from : ev.echo.to);
      const isDoctor = ev.type === "patient_message" && this.d.doctorPhones.has(phone);
      // Doctors get their own chain: their commands lock the patient's chain explicitly via withConversation.
      const key = isDoctor ? `doctor:${phone}` : phone;
      const isNew = await this.d.events.insertIfNew(id, rawPayload);
      if (!isNew) { await this.d.audit.record({ type: "duplicate_event", data: { externalId: id } }); continue; }
      this.schedule(key, async () => {
        try {
          if (ev.type === "doctor_echo") await this.d.engine.handleDoctorEcho(ev.echo);
          else if (isDoctor) await this.d.relay.handleDoctorMessage(ev.message);
          else await this.d.engine.handlePatientMessage(ev.message);
        } catch (e) {
          this.d.log("processing error", { id, error: String(e) });
          try { await this.d.audit.record({ type: "processing_error", data: { externalId: id, error: String(e) } }); }
          catch (e2) { this.d.log("audit record failed", { id, error: String(e2) }); }
        } finally {
          try { await this.d.events.markProcessed(id); }
          catch (e) { this.d.log("markProcessed failed", { id, error: String(e) }); }
        }
      });
    }
  }

  /** Runs fn on the patient's chain so it never interleaves with that patient's own messages. */
  withConversation<T>(phone: string, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.schedule(normalisePhone(phone), async () => {
        try { resolve(await fn()); } catch (e) { reject(e); }
      });
    });
  }

  /** Serialises jobs per key so one phone's messages never interleave. */
  private schedule(key: string, job: () => Promise<void>) {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(job, job).catch((e) => { this.d.log("job chain error", { key, error: String(e) }); });
    this.chains.set(key, next);
    this.pending.add(next);
    next.finally(() => { this.pending.delete(next); if (this.chains.get(key) === next) this.chains.delete(key); });
  }

  async idle() { while (this.pending.size) await Promise.allSettled([...this.pending]); }
}
