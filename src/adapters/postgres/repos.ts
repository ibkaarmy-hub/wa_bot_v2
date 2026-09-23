import pg from "pg";
import type { AuditLog, Conversation, ConversationRepo, Direction, DoctorStateRepo, OutboundItem, OutboundQueue, RelayOrigin, StoredMessage } from "../../core/ports.js";

function rowToConv(r: any): Conversation {
  return {
    id: r.id, phone: r.phone, mode: r.mode, otherCount: r.other_count, lastPatientAt: r.last_patient_at, lastHumanAt: r.last_human_at,
    code: r.code ?? null, claimedBy: r.claimed_by ?? null, handoffAt: r.handoff_at ?? null, realertCount: r.realert_count ?? 0,
  };
}

export class PgConversationRepo implements ConversationRepo {
  constructor(private pool: pg.Pool) {}
  async getByPhone(phone: string) {
    const r = await this.pool.query("select * from conversations where phone=$1", [phone]);
    return r.rows[0] ? rowToConv(r.rows[0]) : null;
  }
  async getById(id: string) {
    const r = await this.pool.query("select * from conversations where id=$1", [id]);
    return r.rows[0] ? rowToConv(r.rows[0]) : null;
  }
  async getByCode(code: string) {
    const r = await this.pool.query("select * from conversations where code=$1", [code.toUpperCase()]);
    return r.rows[0] ? rowToConv(r.rows[0]) : null;
  }
  async listPending() {
    const r = await this.pool.query("select * from conversations where mode='human' and claimed_by is null and handoff_at is not null and realert_count < 2 order by handoff_at");
    return r.rows.map(rowToConv);
  }
  async listClaimedBy(doctorId: string) {
    const r = await this.pool.query("select * from conversations where claimed_by=$1 order by last_patient_at desc nulls last", [doctorId]);
    return r.rows.map(rowToConv);
  }
  async messagesSince(convId: string, at: Date): Promise<StoredMessage[]> {
    const r = await this.pool.query("select direction, text, created_at from messages where conversation_id=$1 and created_at >= $2 order by id", [convId, at]);
    return r.rows.map(x => ({ direction: x.direction, text: x.text, at: x.created_at }));
  }
  async create(phone: string) {
    const r = await this.pool.query("insert into conversations(phone) values ($1) returning *", [phone]);
    return rowToConv(r.rows[0]);
  }
  async save(c: Conversation) {
    await this.pool.query(
      `update conversations set mode=$2, other_count=$3, last_patient_at=$4, last_human_at=$5,
         code=$6, claimed_by=$7, handoff_at=$8, realert_count=$9, updated_at=now() where id=$1`,
      [c.id, c.mode, c.otherCount, c.lastPatientAt, c.lastHumanAt, c.code, c.claimedBy, c.handoffAt, c.realertCount]);
  }
  async appendMessage(convId: string, m: { direction: Direction; text: string; externalId?: string; at: Date }) {
    await this.pool.query("insert into messages(conversation_id, direction, text, external_id, created_at) values ($1,$2,$3,$4,$5)",
      [convId, m.direction, m.text, m.externalId ?? null, m.at]);
  }
  async recentMessages(convId: string, limit: number): Promise<StoredMessage[]> {
    const r = await this.pool.query(
      "select direction, text, created_at from (select * from messages where conversation_id=$1 order by id desc limit $2) t order by id asc",
      [convId, limit]);
    return r.rows.map(x => ({ direction: x.direction, text: x.text, at: x.created_at }));
  }
}

export class PgDoctorState implements DoctorStateRepo {
  constructor(private pool: pg.Pool) {}
  async getActive(doctorId: string) {
    const r = await this.pool.query("select active_conversation_id from doctor_state where doctor_id=$1", [doctorId]);
    return r.rows[0]?.active_conversation_id ?? null;
  }
  async setActive(doctorId: string, conversationId: string | null) {
    await this.pool.query(
      `insert into doctor_state(doctor_id, active_conversation_id, updated_at) values ($1,$2,now())
       on conflict (doctor_id) do update set active_conversation_id=excluded.active_conversation_id, updated_at=now()`,
      [doctorId, conversationId]);
  }
}

export interface OutboundRow { id: number; to: string; kind: "text" | "template"; body: string | null; template: string | null; params: string[] | null; attempts: number; conversationId: string | null; origin: RelayOrigin | null; }

export class PgOutbox implements OutboundQueue {
  constructor(private pool: pg.Pool) {}
  async enqueue(item: OutboundItem) {
    await this.pool.query(
      "insert into outbound_messages(conversation_id, to_phone, kind, body, template, params, origin) values ($1,$2,$3,$4,$5,$6,$7)",
      [item.conversationId ?? null, item.to, item.kind,
       item.kind === "text" ? item.body : null,
       item.kind === "template" ? item.template : null,
       item.kind === "template" ? JSON.stringify(item.params) : null,
       item.origin ? JSON.stringify(item.origin) : null]);
  }
  /** Atomically claims due rows (status → sending, attempts+1).
   *  Two subtleties, both confirmed empirically with a standalone repro script, not just seen
   *  once in CI:
   *  1) Postgres does not preserve the subquery's ORDER BY in an UPDATE ... RETURNING's row
   *     order (it flips nondeterministically between planner runs), so rows are re-sorted by
   *     id here to give callers a stable FIFO order.
   *  2) `next_attempt_at` defaults to the database's own `now()` at insert time, but `now`
   *     here is a client (Node process) clock reading. Any clock skew or network latency
   *     between app and DB (routine under Docker, possible in any real deployment) can make a
   *     just-inserted row's own timestamp appear to be microseconds in the future relative to
   *     the client's `now`, silently excluding it. Comparing against greatest($1, now()) uses
   *     the database's own clock as a floor, which only ever widens the eligible set — it can
   *     never exclude a row that a plain `<= $1` would have included — so genuinely delayed
   *     retries (whose next_attempt_at is far in the future) are still correctly excluded. */
  async claimDue(limit: number, now: Date): Promise<OutboundRow[]> {
    const r = await this.pool.query(
      `update outbound_messages set status='sending', attempts=attempts+1, claimed_at=now()
       where id in (select id from outbound_messages where status='pending' and next_attempt_at<=greatest($1, now()) order by id limit $2 for update skip locked)
       returning id, to_phone, kind, body, template, params, attempts, conversation_id, origin`, [now, limit]);
    return r.rows
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map(x => ({ id: Number(x.id), to: x.to_phone, kind: x.kind, body: x.body, template: x.template, params: x.params, attempts: x.attempts, conversationId: x.conversation_id, origin: x.origin ?? null }));
  }
  /** Recovers rows an instance claimed (flipped to 'sending') but never resolved — for example the
   *  process crashed mid-send. Any row still 'sending' past the staleness cutoff is put back to
   *  'pending' so the next tick (on any instance) retries it. */
  async releaseStale(olderThan: Date): Promise<number> {
    const r = await this.pool.query(
      "update outbound_messages set status='pending', claimed_at=null where status='sending' and claimed_at < $1",
      [olderThan]);
    return r.rowCount ?? 0;
  }
  async markSent(id: number, externalId: string) {
    await this.pool.query("update outbound_messages set status='sent', external_id=$2, sent_at=now(), last_error=null where id=$1", [id, externalId]);
  }
  async markFailed(id: number, error: string, nextAttemptAt: Date | null) {
    if (nextAttemptAt) {
      await this.pool.query("update outbound_messages set status='pending', last_error=$2, next_attempt_at=$3 where id=$1", [id, error, nextAttemptAt]);
    } else {
      await this.pool.query("update outbound_messages set status='failed', last_error=$2 where id=$1", [id, error]);
    }
  }
}

export class PgAudit implements AuditLog {
  constructor(private pool: pg.Pool) {}
  async record(e: { conversationId?: string; type: string; data?: unknown }) {
    await this.pool.query("insert into audit_events(conversation_id, type, data) values ($1,$2,$3)", [e.conversationId ?? null, e.type, e.data === undefined ? null : JSON.stringify(e.data)]);
  }
}

export class PgInboundEvents {
  constructor(private pool: pg.Pool) {}
  async insertIfNew(externalId: string, payload: unknown): Promise<boolean> {
    const r = await this.pool.query("insert into inbound_events(external_id, payload) values ($1,$2) on conflict do nothing", [externalId, JSON.stringify(payload)]);
    return (r.rowCount ?? 0) > 0;
  }
  async markProcessed(externalId: string) {
    await this.pool.query("update inbound_events set processed_at=now() where external_id=$1", [externalId]);
  }
}
