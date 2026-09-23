// Pure interfaces. Nothing in src/core may import from src/adapters.

export type Intent = "book_visit" | "faq" | "reschedule_or_cancel" | "urgent" | "talk_to_human" | "other";
export type Mode = "bot" | "human" | "closed";
export interface InboundMessage { externalId: string; from: string; text: string; at: Date; }
export interface DoctorEcho { externalId: string; to: string; text: string; at: Date; }
export interface Conversation {
  id: string; phone: string; mode: Mode; otherCount: number; lastPatientAt: Date | null; lastHumanAt: Date | null;
  code: string | null; claimedBy: string | null; handoffAt: Date | null; realertCount: number;
}
export type Direction = "in" | "out" | "doctor";
export interface StoredMessage { direction: Direction; text: string; at: Date; }
export interface DoctorMessage { externalId: string; from: string; text: string; at: Date; }
export interface RelayOrigin { doctorId: string; bound: "patient" | "doctor"; }
export interface ConversationRepo {
  getByPhone(phone: string): Promise<Conversation | null>;
  getById(id: string): Promise<Conversation | null>;
  getByCode(code: string): Promise<Conversation | null>;
  listPending(): Promise<Conversation[]>;                 // mode human, claimedBy null, handoffAt set, realertCount < 2; oldest first
  listClaimedBy(doctorId: string): Promise<Conversation[]>;
  messagesSince(convId: string, at: Date): Promise<StoredMessage[]>;   // inclusive of `at`, oldest first
  create(phone: string): Promise<Conversation>;
  save(conv: Conversation): Promise<void>;
  appendMessage(convId: string, msg: { direction: Direction; text: string; externalId?: string; at: Date }): Promise<void>;
  recentMessages(convId: string, limit: number): Promise<StoredMessage[]>;
}
export interface DoctorStateRepo {
  getActive(doctorId: string): Promise<string | null>;
  setActive(doctorId: string, conversationId: string | null): Promise<void>;
}
export interface ConversationLock { withConversation<T>(phone: string, fn: () => Promise<T>): Promise<T>; }
export type OutboundItem =
  | { kind: "text"; to: string; body: string; conversationId?: string; origin?: RelayOrigin }
  | { kind: "template"; to: string; template: string; params: string[]; conversationId?: string; origin?: RelayOrigin };
export interface OutboundQueue { enqueue(item: OutboundItem): Promise<void>; }
export interface AuditLog { record(e: { conversationId?: string; type: string; data?: unknown }): Promise<void>; }
export interface MessagingPort {
  sendText(to: string, body: string): Promise<{ id: string }>;
  sendTemplate(to: string, template: string, params: string[]): Promise<{ id: string }>;
}
export interface FaqEntry { id: string; question: string; answer: string; }
export interface LlmPort {
  classifyIntent(input: { history: StoredMessage[]; message: string }): Promise<{ intent: Intent; confidence: number }>;
  selectFaq(input: { faq: FaqEntry[]; message: string }): Promise<{ faqId: string | null }>;
}
export interface Clock { now(): Date; }
