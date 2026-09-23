// src/core/services/relay/messaging.ts
// Everything the relay sends: texts to doctors and patients, and doctor alerts. Never takes the conversation lock.
import { onDutyDoctors } from "../../lib/roster.js";
import { render } from "../../lib/text.js";
import type { Conversation } from "../../ports.js";
import type { Doctor, MessageKey, RelayCtx } from "./context.js";

/** Text to a doctor's own WhatsApp. Blank rendered text = suppressed. Not stored as a conversation message. */
export async function tell(c: RelayCtx, doctor: Doctor, key: MessageKey, vars: Record<string, string>, conversationId?: string) {
  const text = render(c.d.config.messages[key], vars);
  if (!text.trim()) return;
  await c.d.outbox.enqueue({ kind: "text", to: doctor.whatsapp, body: text, conversationId });
}

/** Text to the patient, stored on the conversation like any bot reply. Blank = suppressed. */
export async function tellPatient(c: RelayCtx, conv: Conversation, key: MessageKey, vars: Record<string, string>) {
  const text = render(c.d.config.messages[key], vars);
  if (!text.trim()) return;
  await c.d.outbox.enqueue({ kind: "text", to: conv.phone, body: text, conversationId: conv.id });
  await c.d.repo.appendMessage(conv.id, { direction: "out", text, at: c.d.clock.now() });
}

export async function lastPatientLine(c: RelayCtx, conv: Conversation): Promise<string> {
  const recent = await c.d.repo.recentMessages(conv.id, 10);
  return recent.filter(m => m.direction === "in").at(-1)?.text ?? "";
}

/** Single line, at most 300 characters counted by code point so an emoji is never cut in half. */
export function alertSummary(conv: Conversation, lastText: string, urgent: boolean): string {
  const line = `${urgent ? "URGENT " : ""}${conv.code} · ${conv.phone} · ${lastText}`.replace(/\s+/g, " ").trim();
  return Array.from(line).slice(0, 300).join("");
}

export async function sendAlert(c: RelayCtx, doctor: Doctor, summary: string, conversationId: string) {
  await c.d.outbox.enqueue({ kind: "template", to: doctor.whatsapp, template: c.d.config.settings.templates.doctor_alert, params: [summary], conversationId });
}

export async function alertOnDuty(c: RelayCtx, conv: Conversation, lastText: string, urgent: boolean) {
  const { settings, roster } = c.d.config;
  const summary = alertSummary(conv, lastText, urgent);
  for (const doc of onDutyDoctors(roster, c.d.clock.now(), settings.timezone)) await sendAlert(c, doc, summary, conv.id);
}
