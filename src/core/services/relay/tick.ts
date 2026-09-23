// src/core/services/relay/tick.ts
// Timer: runs every `relay_tick_seconds` and escalates unclaimed hand-offs (spec §5.3). Each conversation under its lock.
import { vars, type RelayCtx } from "./context.js";
import { alertOnDuty, lastPatientLine, tellPatient } from "./messaging.js";

export async function tick(c: RelayCtx): Promise<void> {
  const stepMs = c.d.config.settings.handoff_realert_minutes * 60_000;
  for (const p of await c.d.repo.listPending()) {
    try {
      await c.d.lock.withConversation(p.phone, async () => {
        const conv = (await c.d.repo.getById(p.id))!;
        if (conv.mode !== "human" || conv.claimedBy || !conv.handoffAt) return;   // claimed or released since listing
        const age = c.d.clock.now().getTime() - conv.handoffAt.getTime();
        if (conv.realertCount === 0 && age >= stepMs) {
          conv.realertCount = 1;
          await c.d.repo.save(conv);
          await alertOnDuty(c, conv, await lastPatientLine(c, conv), true);
          await c.d.audit.record({ conversationId: conv.id, type: "handoff_realert", data: { code: conv.code } });
        } else if (conv.realertCount === 1 && age >= 2 * stepMs) {
          conv.realertCount = 2;
          await c.d.repo.save(conv);
          await tellPatient(c, conv, "handoff_unclaimed", vars(c, { conv }));
          await c.d.audit.record({ conversationId: conv.id, type: "handoff_unclaimed", data: { code: conv.code } });
        }
      });
    } catch (e) {
      try {
        await c.d.audit.record({ conversationId: p.id, type: "relay_tick_error", data: { code: p.code, error: String(e) } });
      } catch { /* swallow: a failing audit must not block the rest of the tick */ }
    }
  }
}
