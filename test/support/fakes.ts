import type {
  AuditLog, Clock, Conversation, ConversationLock, ConversationRepo, Direction, DoctorStateRepo, FaqEntry, Intent,
  LlmPort, OutboundItem, OutboundQueue, StoredMessage,
} from "../../src/core/ports.js";

export class InMemoryConversationRepo implements ConversationRepo {
  convs = new Map<string, Conversation>();   // keyed by phone
  messages = new Map<string, Array<StoredMessage & { externalId?: string }>>();
  private seq = 0;
  private all() { return [...this.convs.values()]; }
  /** Every read returns a shallow copy, as Postgres returns a fresh row: a change without save() is lost. */
  private copy(c: Conversation | undefined): Conversation | null { return c ? { ...c } : null; }
  async getByPhone(phone: string) { return this.copy(this.convs.get(phone)); }
  async getById(id: string) { return this.copy(this.all().find(c => c.id === id)); }
  async getByCode(code: string) { const u = code.toUpperCase(); return this.copy(this.all().find(c => c.code === u)); }
  /** Pending hand-offs the tick still has work for (realertCount < 2). Fully escalated ones stay takeable via getByCode. */
  async listPending() {
    return this.all().filter(c => c.mode === "human" && !c.claimedBy && c.handoffAt !== null && c.realertCount < 2)
      .sort((a, b) => a.handoffAt!.getTime() - b.handoffAt!.getTime()).map(c => ({ ...c }));
  }
  /** Ordered like Postgres: lastPatientAt desc, nulls last. */
  async listClaimedBy(doctorId: string) {
    const byRecent = (a: Conversation, b: Conversation) =>
      a.lastPatientAt && b.lastPatientAt ? b.lastPatientAt.getTime() - a.lastPatientAt.getTime()
        : a.lastPatientAt ? -1 : b.lastPatientAt ? 1 : 0;
    return this.all().filter(c => c.claimedBy === doctorId).sort(byRecent).map(c => ({ ...c }));
  }
  async messagesSince(convId: string, at: Date) {
    return (this.messages.get(convId) ?? []).filter(m => m.at.getTime() >= at.getTime());
  }
  async create(phone: string) {
    const c: Conversation = { id: `c${++this.seq}`, phone, mode: "bot", otherCount: 0, lastPatientAt: null, lastHumanAt: null, code: null, claimedBy: null, handoffAt: null, realertCount: 0 };
    this.convs.set(phone, c); this.messages.set(c.id, []); return { ...c };
  }
  async save(conv: Conversation) {
    const clash = this.all().find(c => c.id !== conv.id && conv.code !== null && c.code === conv.code);
    if (clash) throw new Error(`duplicate code ${conv.code}`);
    this.convs.set(conv.phone, { ...conv });
  }
  async appendMessage(convId: string, msg: { direction: Direction; text: string; externalId?: string; at: Date }) {
    this.messages.get(convId)!.push(msg);
  }
  async recentMessages(convId: string, limit: number) {
    return (this.messages.get(convId) ?? []).slice(-limit);
  }
}

export class InMemoryDoctorState implements DoctorStateRepo {
  active = new Map<string, string | null>();
  async getActive(doctorId: string) { return this.active.get(doctorId) ?? null; }
  async setActive(doctorId: string, conversationId: string | null) { this.active.set(doctorId, conversationId); }
}

/** Tests run one thing at a time; no serialisation needed. */
export const noLock: ConversationLock = { withConversation: (_phone, fn) => fn() };

// Meta rejects template parameters containing newlines/tabs or >4 consecutive spaces; this fake
// does not enforce that — the engine must sanitise.
export class InMemoryOutbox implements OutboundQueue {
  items: OutboundItem[] = [];
  async enqueue(item: OutboundItem) { this.items.push(item); }
  texts(to?: string) { return this.items.filter(i => i.kind === "text" && (!to || i.to === to)).map(i => (i as any).body as string); }
  templates(to?: string) { return this.items.filter(i => i.kind === "template" && (!to || i.to === to)); }
}

export class InMemoryAudit implements AuditLog {
  events: Array<{ conversationId?: string; type: string; data?: unknown }> = [];
  async record(e: { conversationId?: string; type: string; data?: unknown }) { this.events.push(e); }
  types() { return this.events.map(e => e.type); }
}

export class FakeLlm implements LlmPort {
  intents = new Map<string, Intent>();
  faqs = new Map<string, string | null>();
  failNext = false;
  async classifyIntent({ message }: { history: StoredMessage[]; message: string }) {
    if (this.failNext) { this.failNext = false; throw new Error("llm down"); }
    return { intent: this.intents.get(message) ?? "other", confidence: 0.9 };
  }
  async selectFaq({ message }: { faq: FaqEntry[]; message: string }) {
    if (this.failNext) { this.failNext = false; throw new Error("llm down"); }
    return { faqId: this.faqs.get(message) ?? null };
  }
}

export class FixedClock implements Clock {
  constructor(public current: Date) {}
  now() { return this.current; }
  advanceHours(h: number) { this.current = new Date(this.current.getTime() + h * 3600_000); }
  advanceMinutes(m: number) { this.current = new Date(this.current.getTime() + m * 60_000); }
}
