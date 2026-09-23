// src/core/services/relay/handoff.ts
// Engine-facing: open a hand-off, forward or escalate a patient message, release on idle.
// The engine already runs on the patient's chain, so NOTHING in this file takes the conversation lock.
import type { Conversation } from "../../ports.js";
import { holderOf, vars, type Doctor, type RelayCtx } from "./context.js";
import { alertOnDuty, tellPatient } from "./messaging.js";

async function assignCode(c: RelayCtx): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const code = c.newCode();
    if (!(await c.d.repo.getByCode(code))) return code;
  }
  throw new Error("could not allocate a patient code after 20 tries");
}

/** Called by the engine at every hand-off point. Saves the conversation. */
export async function openHandoff(c: RelayCtx, conv: Conversation, lastText: string, urgent: boolean): Promise<void> {
  const now = c.d.clock.now();
  const freshCode = !conv.code;
  if (freshCode) conv.code = await assignCode(c);
  // handoffAt is the timestamp the engine stamped on the triggering patient message (it set lastPatientAt from the
  // same Date it stored the message with, before the LLM call) so the #take replay includes that message.
  conv.mode = "human"; conv.claimedBy = null; conv.handoffAt = conv.lastPatientAt ?? now; conv.realertCount = 0; conv.lastHumanAt = now; conv.otherCount = 0;
  try { await c.d.repo.save(conv); }
  catch (e) {
    if (!freshCode) throw e;
    conv.code = await assignCode(c);   // another chain allocated the same code between our check and our save
    await c.d.repo.save(conv);
  }
  await alertOnDuty(c, conv, lastText, urgent);
  await c.d.audit.record({ conversationId: conv.id, type: "handoff_opened", data: { code: conv.code, urgent } });
}

/** Patient wrote while a doctor holds the conversation. The engine has already stored the message. */
export async function forwardPatientMessage(c: RelayCtx, conv: Conversation, text: string): Promise<void> {
  const doctor = holderOf(c, conv);
  if (!doctor) { await reopenFromDepartedHolder(c, conv, text, false); return; }
  await relayIn(c, conv, doctor, text, false);
}

/**
 * Urgent keyword while the conversation is in human mode (spec §5.2). The engine has stored the message and sent the
 * emergency text. Held by an on-roster doctor: forward marked URGENT. Pending: URGENT re-alert to every on-duty doctor,
 * whatever realertCount says. Held by a doctor who left the roster: re-open the hand-off as urgent. Saves.
 */
export async function escalateUrgent(c: RelayCtx, conv: Conversation, text: string): Promise<void> {
  const doctor = holderOf(c, conv);
  if (doctor) { await relayIn(c, conv, doctor, text, true); return; }
  if (conv.claimedBy) { await reopenFromDepartedHolder(c, conv, text, true); return; }
  await c.d.repo.save(conv);
  await alertOnDuty(c, conv, text, true);
  await c.d.audit.record({ conversationId: conv.id, type: "handoff_realert", data: { code: conv.code, reason: "urgent" } });
}

async function relayIn(c: RelayCtx, conv: Conversation, doctor: Doctor, text: string, urgent: boolean) {
  await c.d.repo.save(conv);
  await c.d.outbox.enqueue({ kind: "text", to: doctor.whatsapp, body: `${urgent ? "URGENT " : ""}${conv.code}: ${text}`, conversationId: conv.id, origin: { doctorId: doctor.id, bound: "doctor" } });
  await c.d.audit.record({ conversationId: conv.id, type: "relay_in", data: { code: conv.code, doctorId: doctor.id, urgent } });
}

/** Holder is no longer on the roster: nobody can receive this. Release and hand off afresh. */
async function reopenFromDepartedHolder(c: RelayCtx, conv: Conversation, text: string, urgent: boolean) {
  await release(c, conv);
  await c.d.audit.record({ conversationId: conv.id, type: "doctor_released", data: { code: conv.code, reason: "holder_left_roster" } });
  await openHandoff(c, conv, text, urgent);
}

/** `human_idle_hours` passed. Puts the conversation back to the bot; the engine then handles the message. */
export async function releaseIdle(c: RelayCtx, conv: Conversation): Promise<void> {
  const wasClaimed = conv.claimedBy !== null;
  await release(c, conv);
  if (wasClaimed) await tellPatient(c, conv, "bot_resumed", vars(c, { conv }));
  await c.d.audit.record({ conversationId: conv.id, type: "human_idle_resumed", data: { code: conv.code, wasClaimed } });
}

/**
 * Shared release: back to bot mode, clear claim and pending state, clear the holder's active pointer. Saves.
 * Takes no lock itself; the doctor-facing caller (commands.ts) calls it inside its own lock.
 */
export async function release(c: RelayCtx, conv: Conversation) {
  const holder = conv.claimedBy;
  conv.claimedBy = null; conv.handoffAt = null; conv.mode = "bot"; conv.otherCount = 0; conv.realertCount = 0;
  await c.d.repo.save(conv);
  if (holder && (await c.d.doctors.getActive(holder)) === conv.id) await c.d.doctors.setActive(holder, null);
}
