import type { DoctorEcho, InboundMessage } from "../../core/ports.js";

export type ParsedEvent =
  | { type: "patient_message"; message: InboundMessage }
  | { type: "doctor_echo"; echo: DoctorEcho }
  | { type: "status"; externalId: string; status: string; recipient: string }
  | { type: "ignored"; reason: string };

type AnyRecord = Record<string, any>;
const toDate = (ts: string) => new Date(Number(ts) * 1000);

export function parseWebhook(body: unknown, echoField: string): ParsedEvent[] {
  const out: ParsedEvent[] = [];
  const b = body as AnyRecord;
  if (!b || b.object !== "whatsapp_business_account" || !Array.isArray(b.entry)) return out;
  for (const entry of b.entry) {
    for (const change of entry.changes ?? []) {
      const value: AnyRecord = change.value ?? {};
      if (change.field === "messages") {
        for (const m of value.messages ?? []) {
          if (m.type === "text" && typeof m.text?.body === "string") {
            out.push({ type: "patient_message", message: { externalId: m.id, from: m.from, text: m.text.body, at: toDate(m.timestamp) } });
          } else {
            out.push({ type: "ignored", reason: `unsupported message type ${m.type} (${m.id})` });
          }
        }
        for (const s of value.statuses ?? []) {
          out.push({ type: "status", externalId: s.id, status: s.status, recipient: s.recipient_id });
        }
      } else if (change.field === echoField) {
        for (const e of value.message_echoes ?? []) {
          if (e.type === "text" && typeof e.text?.body === "string") {
            out.push({ type: "doctor_echo", echo: { externalId: e.id, to: e.to, text: e.text.body, at: toDate(e.timestamp) } });
          } else {
            out.push({ type: "ignored", reason: `unsupported echo type ${e.type} (${e.id})` });
          }
        }
      } else {
        out.push({ type: "ignored", reason: `unknown field ${change.field}` });
      }
    }
  }
  return out;
}
