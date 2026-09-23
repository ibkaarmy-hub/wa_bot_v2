// src/core/services/relay/failures.ts
// Outbox-facing: a relay item was dead-lettered by Meta (typically the 24-hour window closed).
// Changes no conversation state, so it needs no lock.
import type { RelayOrigin } from "../../ports.js";
import { doctorById, vars, type RelayCtx } from "./context.js";
import { alertSummary, lastPatientLine, sendAlert, tell } from "./messaging.js";

export async function handleRelayFailure(c: RelayCtx, origin: RelayOrigin, conversationId: string | null): Promise<void> {
  const doctor = doctorById(c, origin.doctorId);
  if (!doctor) {
    await c.d.audit.record({ conversationId: conversationId ?? undefined, type: "relay_window_closed", data: { doctorId: origin.doctorId, bound: origin.bound, doctorFound: false } });
    return;
  }
  const conv = conversationId ? await c.d.repo.getById(conversationId) : null;
  if (origin.bound === "patient") {
    await tell(c, doctor, "doctor_window_closed", vars(c, { conv, doctor }), conv?.id);
  } else if (conv) {
    await sendAlert(c, doctor, alertSummary(conv, await lastPatientLine(c, conv), false), conv.id);
  }
  await c.d.audit.record({ conversationId: conv?.id, type: "relay_window_closed", data: { doctorId: doctor.id, bound: origin.bound, doctorFound: true } });
}
