// src/core/services/relay/context.ts
// The dependencies every relay file shares, plus roster lookups and template variables.
import type { AppConfig } from "../../../config/load.js";
import { normalisePhone } from "../../lib/phone.js";
import type {
  AuditLog, Clock, Conversation, ConversationLock, ConversationRepo, DoctorStateRepo, OutboundQueue,
} from "../../ports.js";

export type Doctor = AppConfig["roster"]["doctors"][number];
export type MessageKey = keyof AppConfig["messages"];

export interface RelayDeps {
  repo: ConversationRepo; doctors: DoctorStateRepo; outbox: OutboundQueue; audit: AuditLog; clock: Clock;
  config: AppConfig; lock: ConversationLock; generateCode?: () => string;
}

/** What DoctorRelay hands to each relay function: its deps and the code generator it settled on. */
export interface RelayCtx { d: RelayDeps; newCode: () => string; }

export function doctorById(c: RelayCtx, id: string): Doctor | undefined { return c.d.config.roster.doctors.find(doc => doc.id === id); }
/** The doctor holding the conversation, if they are still on the roster. A holder who left the roster counts as nobody. */
export function holderOf(c: RelayCtx, conv: Conversation): Doctor | undefined { return conv.claimedBy ? doctorById(c, conv.claimedBy) : undefined; }
export function doctorByPhone(c: RelayCtx, phone: string): Doctor | undefined {
  const p = normalisePhone(phone);
  return c.d.config.roster.doctors.find(doc => doc.whatsapp === p);
}

export function vars(c: RelayCtx, o: { conv?: Conversation | null; doctor?: Doctor | null; code?: string | null } = {}): Record<string, string> {
  return {
    clinic_name: c.d.config.settings.clinic_name,
    doctor_name: o.doctor?.name ?? "",
    code: o.code ?? o.conv?.code ?? "",
    patient_phone: o.conv?.phone ?? "",
  };
}
