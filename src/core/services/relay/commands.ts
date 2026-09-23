// src/core/services/relay/commands.ts
// Doctor-facing: a message from a roster doctor's own WhatsApp (#take, #bot, #list, #help, #call, or a reply).
// Every change to a conversation here happens inside lock.withConversation(patient phone).
import { render } from "../../lib/text.js";
import type { Conversation, DoctorMessage } from "../../ports.js";
import { doctorByPhone, holderOf, vars, type Doctor, type MessageKey, type RelayCtx } from "./context.js";
import { release } from "./handoff.js";
import { lastPatientLine, tell, tellPatient } from "./messaging.js";
import { parseDoctorCommand } from "./parser.js";

export async function handleDoctorMessage(c: RelayCtx, msg: DoctorMessage): Promise<void> {
  const doctor = doctorByPhone(c, msg.from);
  if (!doctor) return;
  const cmd = parseDoctorCommand(msg.text);
  switch (cmd.kind) {
    case "take": return take(c, doctor, cmd.code);
    case "release": return releaseByDoctor(c, doctor, cmd.code);
    case "list": return list(c, doctor);
    case "help": return tell(c, doctor, "doctor_help", vars(c, { doctor }));
    case "call": return tell(c, doctor, "doctor_call_unavailable", vars(c, { doctor }));
    case "unknown": return tell(c, doctor, "doctor_help", vars(c, { doctor }));
    case "text": return relayText(c, doctor, cmd.code, cmd.text, msg);
  }
}

async function reject(c: RelayCtx, doctor: Doctor, key: MessageKey, v: Record<string, string>, reason: string, conversationId?: string) {
  await tell(c, doctor, key, v, conversationId);
  await c.d.audit.record({ conversationId, type: "doctor_command_rejected", data: { doctorId: doctor.id, reason } });
}

async function take(c: RelayCtx, doctor: Doctor, code: string) {
  const found = await c.d.repo.getByCode(code);
  if (!found) { await reject(c, doctor, "doctor_unknown_code", vars(c, { doctor, code }), "unknown_code"); return; }
  await c.d.lock.withConversation(found.phone, async () => {
    const conv = (await c.d.repo.getById(found.id))!;
    if (conv.mode !== "human") { await reject(c, doctor, "doctor_not_pending", vars(c, { conv, doctor }), "not_pending", conv.id); return; }
    const holder = holderOf(c, conv);
    if (holder && holder.id !== doctor.id) {
      await reject(c, doctor, "doctor_taken_by_other", vars(c, { conv, doctor: holder }), "taken_by_other", conv.id);
      return;
    }
    const now = c.d.clock.now();
    const alreadyMine = conv.claimedBy === doctor.id;
    const since = conv.handoffAt ?? conv.lastHumanAt ?? now;
    conv.claimedBy = doctor.id; conv.handoffAt = null; conv.lastHumanAt = now;
    await c.d.repo.save(conv);
    await c.d.doctors.setActive(doctor.id, conv.id);
    await tell(c, doctor, "doctor_took", vars(c, { conv, doctor }), conv.id);
    if (alreadyMine) return;
    const held = (await c.d.repo.messagesSince(conv.id, since)).filter(m => m.direction === "in");
    for (const m of held) {
      await c.d.outbox.enqueue({ kind: "text", to: doctor.whatsapp, body: `${conv.code}: ${m.text}`, conversationId: conv.id, origin: { doctorId: doctor.id, bound: "doctor" } });
    }
    await tellPatient(c, conv, "doctor_joined", vars(c, { conv, doctor }));
    await c.d.audit.record({ conversationId: conv.id, type: "doctor_claimed", data: { code: conv.code, doctorId: doctor.id, held: held.length } });
  });
}

async function releaseByDoctor(c: RelayCtx, doctor: Doctor, code: string | null) {
  const target = await resolveHeld(c, doctor, code);
  if (!target) return;
  await c.d.lock.withConversation(target.phone, async () => {
    const conv = (await c.d.repo.getById(target.id))!;
    if (conv.claimedBy !== doctor.id) { await reject(c, doctor, "doctor_no_active", vars(c, { conv, doctor }), "not_holder", conv.id); return; }
    await release(c, conv);
    await tell(c, doctor, "doctor_released", vars(c, { conv, doctor }), conv.id);
    await tellPatient(c, conv, "bot_resumed", vars(c, { conv }));
    await c.d.audit.record({ conversationId: conv.id, type: "doctor_released", data: { code: conv.code, doctorId: doctor.id, reason: "command" } });
  });
}

/** The conversation a doctor is addressing: by code if given, else their active one. Sends the rejection itself and returns null on failure. */
async function resolveHeld(c: RelayCtx, doctor: Doctor, code: string | null): Promise<Conversation | null> {
  if (code) {
    const conv = await c.d.repo.getByCode(code);
    if (!conv) { await reject(c, doctor, "doctor_unknown_code", vars(c, { doctor, code }), "unknown_code"); return null; }
    if (conv.claimedBy === doctor.id) return conv;
    const holder = holderOf(c, conv);
    if (holder) { await reject(c, doctor, "doctor_taken_by_other", vars(c, { conv, doctor: holder }), "taken_by_other", conv.id); return null; }
    await reject(c, doctor, "doctor_not_taken", vars(c, { conv, doctor }), "not_taken", conv.id);
    return null;
  }
  const activeId = await c.d.doctors.getActive(doctor.id);
  const conv = activeId ? await c.d.repo.getById(activeId) : null;
  if (!conv || conv.claimedBy !== doctor.id) { await reject(c, doctor, "doctor_no_active", vars(c, { doctor }), "no_active"); return null; }
  return conv;
}

async function relayText(c: RelayCtx, doctor: Doctor, code: string | null, text: string, msg: DoctorMessage) {
  let target: Conversation | null = null;
  let body = text;
  let explicit = false;
  if (code) {
    if (await c.d.repo.getByCode(code)) {
      // An existing code: the doctor must hold it (spec §8). Otherwise resolveHeld rejects and nothing is relayed.
      target = await resolveHeld(c, doctor, code);
      if (!target) return;
      explicit = true;
    } else body = msg.text.trim();                     // code-shaped but no such patient: relay the whole message
  }
  if (!target) target = await resolveHeld(c, doctor, null);
  if (!target) return;
  await c.d.lock.withConversation(target.phone, async () => {
    const conv = (await c.d.repo.getById(target!.id))!;
    if (conv.claimedBy !== doctor.id) { await reject(c, doctor, "doctor_no_active", vars(c, { doctor }), "not_holder", conv.id); return; }
    const now = c.d.clock.now();
    await c.d.repo.appendMessage(conv.id, { direction: "doctor", text: body, externalId: msg.externalId, at: now });
    await c.d.outbox.enqueue({ kind: "text", to: conv.phone, body, conversationId: conv.id, origin: { doctorId: doctor.id, bound: "patient" } });
    conv.lastHumanAt = now;
    await c.d.repo.save(conv);
    if (explicit) await c.d.doctors.setActive(doctor.id, conv.id);
    else if ((await c.d.repo.listClaimedBy(doctor.id)).length > 1) await tell(c, doctor, "doctor_relayed_to", vars(c, { conv, doctor }), conv.id);
    await c.d.audit.record({ conversationId: conv.id, type: "relay_out", data: { code: conv.code, doctorId: doctor.id, explicit } });
  });
}

/** Read-only summary of the doctor's held patients; changes nothing, so it takes no lock. */
async function list(c: RelayCtx, doctor: Doctor) {
  const held = await c.d.repo.listClaimedBy(doctor.id);
  if (held.length === 0) { await tell(c, doctor, "doctor_list_empty", vars(c, { doctor })); return; }
  const now = c.d.clock.now().getTime();
  const lines: string[] = [render(c.d.config.messages.doctor_list_header, vars(c, { doctor }))];
  for (const conv of held) {
    const last = (await lastPatientLine(c, conv)).replace(/\s+/g, " ").slice(0, 60);
    const ago = conv.lastPatientAt ? ` · ${Math.round((now - conv.lastPatientAt.getTime()) / 60_000)}m ago` : "";
    lines.push(`${conv.code} · ${conv.phone} · ${last}${ago}`);
  }
  await c.d.outbox.enqueue({ kind: "text", to: doctor.whatsapp, body: lines.join("\n") });
}
