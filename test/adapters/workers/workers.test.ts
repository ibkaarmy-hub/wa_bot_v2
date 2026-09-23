import { describe, it, expect, beforeEach } from "vitest";
import { InboundWorker } from "../../../src/adapters/workers/inbound.js";
import { OutboxWorker, backoffMs } from "../../../src/adapters/workers/outbox.js";
import { RelayWorker } from "../../../src/adapters/workers/relay.js";
import { Engine } from "../../../src/core/services/engine.js";
import { DoctorRelay } from "../../../src/core/services/relay/index.js";
import { loadConfig } from "../../../src/config/load.js";
import { FakeLlm, FixedClock, InMemoryAudit, InMemoryConversationRepo, InMemoryDoctorState, InMemoryOutbox, noLock } from "../../support/fakes.js";
import type { OutboundRow } from "../../../src/adapters/postgres/repos.js";

class MemEvents {
  seen = new Set<string>(); processed: string[] = [];
  async insertIfNew(id: string) { if (this.seen.has(id)) return false; this.seen.add(id); return true; }
  async markProcessed(id: string) { this.processed.push(id); }
}

describe("InboundWorker", () => {
  let repo: InMemoryConversationRepo, outbox: InMemoryOutbox, audit: InMemoryAudit, engine: Engine, relay: DoctorRelay, events: MemEvents, worker: InboundWorker;
  beforeEach(() => {
    repo = new InMemoryConversationRepo(); outbox = new InMemoryOutbox(); audit = new InMemoryAudit();
    const config = loadConfig("test/fixtures/config"); const clock = new FixedClock(new Date());
    relay = new DoctorRelay({ repo, doctors: new InMemoryDoctorState(), outbox, audit, clock, config, lock: noLock });
    engine = new Engine({ repo, outbox, audit, llm: new FakeLlm(), clock, config, relay });
    events = new MemEvents();
    worker = new InboundWorker({ engine, relay, doctorPhones: new Set(["+6590000001", "+6590000002"]), events, audit, log: () => {} });
  });
  const pm = (id: string, text: string, from = "6591234567") => ({ type: "patient_message" as const, message: { externalId: id, from, text, at: new Date() } });

  it("processes new events and skips duplicates", async () => {
    await worker.accept([pm("a", "hello"), pm("a", "hello")], {});
    await worker.idle();
    expect(events.processed).toEqual(["a"]);
    expect(outbox.texts()).toHaveLength(1);
    expect(audit.types()).toContain("duplicate_event");
  });

  it("processes messages from the same phone in order", async () => {
    await worker.accept([pm("1", "asdf"), pm("2", "qwer")], {});
    await worker.idle();
    const conv = (await repo.getByPhone("+6591234567"))!;
    expect((await repo.recentMessages(conv.id, 10)).filter(m => m.direction === "in").map(m => m.text)).toEqual(["asdf", "qwer"]);
    expect(conv.mode).toBe("human"); // second 'other' → handoff
  });

  it("records ignored events and statuses to the audit log without touching the engine", async () => {
    await worker.accept([{ type: "ignored", reason: "unsupported" }, { type: "status", externalId: "x", status: "read", recipient: "65" }], {});
    await worker.idle();
    expect(audit.types()).toEqual(["event_ignored", "delivery_status"]);
    expect(outbox.items).toHaveLength(0);
  });

  it("survives an engine error and still marks the event processed", async () => {
    const bad = new InboundWorker({ engine: { handlePatientMessage: async () => { throw new Error("boom"); }, handleDoctorEcho: async () => {} }, relay: { handleDoctorMessage: async () => {} }, doctorPhones: new Set<string>(), events, audit, log: () => {} });
    await bad.accept([pm("z", "x")], {});
    await bad.idle();
    expect(audit.types()).toContain("processing_error");
    expect(events.processed).toEqual(["z"]);
  });

  it("does not produce an unhandled rejection when markProcessed throws", async () => {
    const logs: string[] = [];
    const badEvents = { insertIfNew: async () => true, markProcessed: async () => { throw new Error("db down"); } };
    const w = new InboundWorker({ engine, relay, doctorPhones: new Set<string>(), events: badEvents as any, audit, log: (m) => { logs.push(m); } });
    await w.accept([pm("m1", "hello")], {});
    await w.idle();
    expect(logs).toContain("markProcessed failed");
    expect(outbox.texts()).toHaveLength(1); // engine still ran
  });

  it("routes messages from roster numbers to the relay, never to the engine", async () => {
    let doctorCalls = 0;
    const r = { handleDoctorMessage: async () => { doctorCalls++; } };
    const w = new InboundWorker({ engine, relay: r, doctorPhones: new Set(["+6590000001"]), events, audit, log: () => {} });
    await w.accept([pm("d1", "#list", "6590000001")], {});
    await w.idle();
    expect(doctorCalls).toBe(1);
    expect(await repo.getByPhone("+6590000001")).toBeNull();
  });

  it("withConversation runs on the patient's chain, after that patient's queued messages", async () => {
    const order: string[] = [];
    const slowEngine = { handlePatientMessage: async () => { await new Promise(r => setTimeout(r, 10)); order.push("patient"); }, handleDoctorEcho: async () => {} };
    const w = new InboundWorker({ engine: slowEngine, relay, doctorPhones: new Set<string>(), events, audit, log: () => {} });
    await w.accept([pm("p1", "hi", "6591234567")], {});
    const result = await w.withConversation("+6591234567", async () => { order.push("locked"); return 42; });
    expect(result).toBe(42);
    expect(order).toEqual(["patient", "locked"]);
    await expect(w.withConversation("6591234567", async () => { throw new Error("inner"); })).rejects.toThrow("inner");
  });
});

describe("backoffMs", () => {
  it("grows quadratically and caps at 10 minutes", () => {
    expect(backoffMs(1)).toBe(5000); expect(backoffMs(2)).toBe(20000); expect(backoffMs(3)).toBe(45000); expect(backoffMs(20)).toBe(600000);
  });
});

describe("OutboxWorker", () => {
  function setup(rows: OutboundRow[], fail?: { status: number; retryable: boolean }, onPermanentFailure?: (row: OutboundRow) => Promise<void>) {
    const sent: string[] = []; const marked: any[] = [];
    const outbox = {
      claimDue: async () => rows.splice(0),
      releaseStale: async () => 0,
      markSent: async (id: number, ext: string) => { marked.push(["sent", id, ext]); },
      markFailed: async (id: number, err: string, next: Date | null) => { marked.push(["failed", id, err, next ? "retry" : "dead"]); },
    };
    const messaging = {
      sendText: async (to: string, body: string) => { if (fail) throw Object.assign(new Error("meta"), fail); sent.push(`text:${to}:${body}`); return { id: "w1" }; },
      sendTemplate: async (to: string, t: string, p: string[]) => { if (fail) throw Object.assign(new Error("meta"), fail); sent.push(`tpl:${to}:${t}:${p.join(",")}`); return { id: "w2" }; },
    };
    const audit = new InMemoryAudit();
    const logs: Array<[string, unknown?]> = [];
    const w = new OutboxWorker({ outbox, messaging, audit, clock: new FixedClock(new Date()), log: (msg, extra) => logs.push([msg, extra]), maxAttempts: 3, onPermanentFailure });
    return { w, sent, marked, audit, outbox, logs };
  }
  const row = (id: number, attempts = 1): OutboundRow => ({ id, to: "+65", kind: id % 2 ? "text" : "template", body: "hi", template: "doctor_alert", params: ["p"], attempts, conversationId: null, origin: null });

  it("sends due rows and marks them sent", async () => {
    const { w, sent, marked } = setup([row(1), row(2)]);
    expect(await w.tick()).toBe(2);
    expect(sent).toEqual(["text:+65:hi", "tpl:+65:doctor_alert:p"]);
    expect(marked).toEqual([["sent", 1, "w1"], ["sent", 2, "w2"]]);
  });
  it("schedules a retry on a retryable failure and dead-letters after maxAttempts", async () => {
    const { w, marked, audit } = setup([row(1, 1), row(3, 3)], { status: 503, retryable: true });
    await w.tick();
    expect(marked).toEqual([["failed", 1, expect.any(String), "retry"], ["failed", 3, expect.any(String), "dead"]]);
    expect(audit.types()).toContain("outbound_failed_permanently");
  });
  it("dead-letters immediately on a non-retryable failure", async () => {
    const { w, marked } = setup([row(1, 1)], { status: 400, retryable: false });
    await w.tick();
    expect(marked).toEqual([["failed", 1, expect.any(String), "dead"]]);
  });
  it("logs when stale sending rows are released", async () => {
    const { w, outbox, logs } = setup([]);
    outbox.releaseStale = async () => 2;
    await w.tick();
    expect(logs.some(([msg, extra]) => msg === "released stale sending rows" && (extra as any)?.count === 2)).toBe(true);
  });
  it("calls onPermanentFailure with the row once a send is dead-lettered", async () => {
    const seen: OutboundRow[] = [];
    const { w } = setup([{ ...row(1), origin: { doctorId: "dr_example_a", bound: "patient" } }], { status: 400, retryable: false }, async r => { seen.push(r); });
    await w.tick();
    expect(seen).toHaveLength(1);
    expect(seen[0].origin).toEqual({ doctorId: "dr_example_a", bound: "patient" });
  });
  it("survives an onPermanentFailure that throws", async () => {
    const { w, logs } = setup([row(1)], { status: 400, retryable: false }, async () => { throw new Error("hook"); });
    await w.tick();
    expect(logs.some(([m]) => m === "onPermanentFailure error")).toBe(true);
  });
});

describe("RelayWorker", () => {
  it("ticks on an interval, never overlaps, and stops cleanly", async () => {
    let ticks = 0; let inFlight = 0; let overlapped = false;
    const relay = { tick: async () => { inFlight++; if (inFlight > 1) overlapped = true; ticks++; await new Promise(r => setTimeout(r, 15)); inFlight--; } };
    const w = new RelayWorker({ relay, log: () => {} });
    w.start(5);
    await new Promise(r => setTimeout(r, 60));
    await w.stop();
    expect(ticks).toBeGreaterThanOrEqual(2);
    expect(overlapped).toBe(false);
  });
  it("logs a failing tick and keeps going", async () => {
    const logs: string[] = [];
    const w = new RelayWorker({ relay: { tick: async () => { throw new Error("boom"); } }, log: (m) => logs.push(m) });
    w.start(5);
    await new Promise(r => setTimeout(r, 20));
    await w.stop();
    expect(logs).toContain("relay tick error");
  });
});
