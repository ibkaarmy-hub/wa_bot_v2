// src/core/services/relay/index.ts
// Doctor relay: doctors work from their own WhatsApp; the bot relays between them and patients.
// See docs/private/superpowers/specs/2026-09-23-doctor-relay-design.md (not committed).
//
// Which file owns what:
//   index.ts      DoctorRelay, the one public class. Holds the deps and delegates to the files below.
//   context.ts    RelayDeps, the shared context, roster lookups (doctor by id/phone, holder) and template variables.
//   parser.ts     parseDoctorCommand: doctor text -> command. Pure.
//   messaging.ts  Sending: texts to doctors and patients, doctor alerts and their one-line summary.
//   handoff.ts    Engine-facing: openHandoff, forwardPatientMessage, escalateUrgent, releaseIdle, release, code assignment.
//   commands.ts   Doctor-facing: handleDoctorMessage and the #take/#bot/#list/#help/#call/reply handlers.
//   tick.ts       Timer: re-alert and "unclaimed" escalation for pending hand-offs.
//   failures.ts   Outbox-facing: handleRelayFailure when Meta dead-letters a relay item.
//
// Lock invariant: the engine-facing methods (handoff.ts: openHandoff, forwardPatientMessage, escalateUrgent,
// releaseIdle and their helpers) NEVER call lock.withConversation, because the engine already runs on the patient's
// chain. The doctor-facing methods (commands.ts) and tick (tick.ts) take lock.withConversation(patient phone) for
// every conversation they change. handleRelayFailure (failures.ts) changes no conversation state and takes no lock.
import { generateCode } from "../../lib/codes.js";
import type { Conversation, DoctorMessage, RelayOrigin } from "../../ports.js";
import { handleDoctorMessage } from "./commands.js";
import type { RelayCtx, RelayDeps } from "./context.js";
import { handleRelayFailure } from "./failures.js";
import { escalateUrgent, forwardPatientMessage, openHandoff, releaseIdle } from "./handoff.js";
import { tick } from "./tick.js";

export type { RelayDeps } from "./context.js";
export { parseDoctorCommand, type DoctorCommand } from "./parser.js";

export class DoctorRelay {
  private c: RelayCtx;
  constructor(d: RelayDeps) { this.c = { d, newCode: d.generateCode ?? (() => generateCode()) }; }

  // ---- engine-facing (no lock) ------------------------------------------------------------
  /** Called by the engine at every hand-off point. Saves the conversation. */
  openHandoff(conv: Conversation, lastText: string, urgent: boolean): Promise<void> { return openHandoff(this.c, conv, lastText, urgent); }
  /** Patient wrote while a doctor holds the conversation. The engine has already stored the message. */
  forwardPatientMessage(conv: Conversation, text: string): Promise<void> { return forwardPatientMessage(this.c, conv, text); }
  /** Urgent keyword while the conversation is in human mode (spec §5.2). Saves. */
  escalateUrgent(conv: Conversation, text: string): Promise<void> { return escalateUrgent(this.c, conv, text); }
  /** `human_idle_hours` passed. Puts the conversation back to the bot; the engine then handles the message. */
  releaseIdle(conv: Conversation): Promise<void> { return releaseIdle(this.c, conv); }

  // ---- doctor-facing (locks per conversation) ---------------------------------------------
  handleDoctorMessage(msg: DoctorMessage): Promise<void> { return handleDoctorMessage(this.c, msg); }

  // ---- timers (locks per conversation) ----------------------------------------------------
  /** Runs every `relay_tick_seconds`. Escalates unclaimed hand-offs (spec §5.3). */
  tick(): Promise<void> { return tick(this.c); }

  // ---- outbox-facing ----------------------------------------------------------------------
  /** A relay item was dead-lettered by Meta (typically the 24-hour window closed). */
  handleRelayFailure(origin: RelayOrigin, conversationId: string | null): Promise<void> { return handleRelayFailure(this.c, origin, conversationId); }
}
