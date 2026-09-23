import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createPool } from "../../../src/adapters/postgres/pool.js";
import { runMigrations } from "../../../src/adapters/postgres/migrate.js";
import { PgAudit, PgConversationRepo, PgDoctorState, PgInboundEvents, PgOutbox } from "../../../src/adapters/postgres/repos.js";

const url = process.env.DATABASE_URL_TEST;
const d = url ? describe : describe.skip;

d("Postgres repositories", () => {
  const pool = createPool(url ?? "postgres://invalid");
  beforeAll(async () => { await runMigrations(pool); });
  beforeEach(async () => { await pool.query("truncate conversations, messages, inbound_events, outbound_messages, audit_events, doctor_state cascade"); });
  afterAll(async () => { await pool.end(); });

  it("migrations are idempotent and safe to run concurrently", async () => {
    expect(await runMigrations(pool)).toEqual([]);
    const results = await Promise.all([runMigrations(pool), runMigrations(pool), runMigrations(pool)]);
    expect(results).toEqual([[], [], []]);
  });

  it("creates, saves and reads conversations and messages", async () => {
    const repo = new PgConversationRepo(pool);
    const c = await repo.create("+6591234567");
    expect(c.mode).toBe("bot");
    c.mode = "human"; c.otherCount = 2; c.lastHumanAt = new Date("2026-09-15T00:00:00Z");
    await repo.save(c);
    const again = await repo.getByPhone("+6591234567");
    expect(again).toMatchObject({ id: c.id, mode: "human", otherCount: 2 });
    expect(again!.lastHumanAt!.toISOString()).toBe("2026-09-15T00:00:00.000Z");
    await repo.appendMessage(c.id, { direction: "in", text: "a", externalId: "w1", at: new Date() });
    await repo.appendMessage(c.id, { direction: "out", text: "b", at: new Date() });
    await repo.appendMessage(c.id, { direction: "in", text: "c", at: new Date() });
    expect((await repo.recentMessages(c.id, 2)).map(m => m.text)).toEqual(["b", "c"]);
  });

  it("dedupes inbound events", async () => {
    const ev = new PgInboundEvents(pool);
    expect(await ev.insertIfNew("wamid.1", { a: 1 })).toBe(true);
    expect(await ev.insertIfNew("wamid.1", { a: 1 })).toBe(false);
    await ev.markProcessed("wamid.1");
    const r = await pool.query("select processed_at from inbound_events where external_id='wamid.1'");
    expect(r.rows[0].processed_at).not.toBeNull();
  });

  it("outbox: enqueue, claim due, mark sent / failed with retry", async () => {
    const ob = new PgOutbox(pool);
    await ob.enqueue({ kind: "text", to: "+65", body: "hi" });
    await ob.enqueue({ kind: "template", to: "+66", template: "doctor_alert", params: ["x"] });
    const due = await ob.claimDue(10, new Date());
    expect(due.map(r => r.kind)).toEqual(["text", "template"]);
    expect(due[1].params).toEqual(["x"]);
    expect(await ob.claimDue(10, new Date())).toEqual([]); // already claimed (status sending)
    await ob.markSent(due[0].id, "wamid.out");
    await ob.markFailed(due[1].id, "503", new Date(Date.now() + 60_000));
    const rows = await pool.query("select status, attempts, external_id from outbound_messages order by id");
    expect(rows.rows).toEqual([
      { status: "sent", attempts: 1, external_id: "wamid.out" },
      { status: "pending", attempts: 1, external_id: null },
    ]);
    await ob.markFailed(due[1].id, "400", null);
    expect((await pool.query("select status from outbound_messages where id=$1", [due[1].id])).rows[0].status).toBe("failed");
  });

  it("releases rows stuck in sending past the staleness cutoff, but not freshly claimed ones", async () => {
    const ob = new PgOutbox(pool);
    await ob.enqueue({ kind: "text", to: "+65", body: "stale" });
    await ob.enqueue({ kind: "text", to: "+66", body: "fresh" });
    const [stale, fresh] = await ob.claimDue(10, new Date());
    await pool.query("update outbound_messages set claimed_at = now() - interval '10 minutes' where id=$1", [stale.id]);
    const releasedCount = await ob.releaseStale(new Date(Date.now() - 120_000));
    expect(releasedCount).toBe(1);
    const rows = await pool.query("select id, status, claimed_at from outbound_messages order by id");
    expect(rows.rows.find(r => Number(r.id) === stale.id)).toMatchObject({ status: "pending", claimed_at: null });
    expect(rows.rows.find(r => Number(r.id) === fresh.id)).toMatchObject({ status: "sending" });
  });

  it("relay fields: code lookup, pending list, claimed list, messages since, doctor state", async () => {
    const repo = new PgConversationRepo(pool);
    const a = await repo.create("+6591234567");
    const b = await repo.create("+6591234568");
    const t0 = new Date("2026-09-15T00:00:00Z"), t1 = new Date("2026-09-15T00:05:00Z");
    a.mode = "human"; a.code = "P7K"; a.handoffAt = t0; a.lastHumanAt = t0; await repo.save(a);
    b.mode = "human"; b.code = "Q2M"; b.claimedBy = "dr_example_a"; b.lastHumanAt = t1; b.realertCount = 1; await repo.save(b);
    expect((await repo.getByCode("p7k"))?.id).toBe(a.id);
    expect((await repo.getById(b.id))).toMatchObject({ code: "Q2M", claimedBy: "dr_example_a", realertCount: 1, handoffAt: null });
    expect((await repo.listPending()).map(c => c.code)).toEqual(["P7K"]);
    expect((await repo.listClaimedBy("dr_example_a")).map(c => c.code)).toEqual(["Q2M"]);
    await repo.appendMessage(a.id, { direction: "in", text: "before", at: new Date("2026-09-14T23:59:00Z") });
    await repo.appendMessage(a.id, { direction: "in", text: "at", at: t0 });
    await repo.appendMessage(a.id, { direction: "out", text: "after", at: t1 });
    expect((await repo.messagesSince(a.id, t0)).map(m => m.text)).toEqual(["at", "after"]);
    await expect(repo.save({ ...b, code: "P7K" })).rejects.toThrow();   // unique code

    const ds = new PgDoctorState(pool);
    expect(await ds.getActive("dr_example_a")).toBeNull();
    await ds.setActive("dr_example_a", b.id);
    expect(await ds.getActive("dr_example_a")).toBe(b.id);
    await ds.setActive("dr_example_a", null);
    expect(await ds.getActive("dr_example_a")).toBeNull();

    const ob = new PgOutbox(pool);
    await ob.enqueue({ kind: "text", to: "+65", body: "hi", origin: { doctorId: "dr_example_a", bound: "patient" } });
    const [row] = await ob.claimDue(1, new Date());
    expect(row.origin).toEqual({ doctorId: "dr_example_a", bound: "patient" });
  });

  it("audit records events", async () => {
    const a = new PgAudit(pool);
    await a.record({ type: "intent", data: { intent: "faq" } });
    expect((await pool.query("select type, data from audit_events")).rows).toEqual([{ type: "intent", data: { intent: "faq" } }]);
  });
});
