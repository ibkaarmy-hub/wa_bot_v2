// src/core/services/engine.ts
import type { AppConfig } from "../../config/load.js";
import { normalisePhone } from "../lib/phone.js";
import { render } from "../lib/text.js";
import type { DoctorRelay } from "./relay/index.js";
import type {
  AuditLog, Clock, Conversation, ConversationRepo, DoctorEcho, InboundMessage, Intent, LlmPort, OutboundQueue,
} from "../ports.js";

export { normalisePhone } from "../lib/phone.js";

type Relay = Pick<DoctorRelay, "openHandoff" | "forwardPatientMessage" | "escalateUrgent" | "releaseIdle">;

export class Engine {
  constructor(private d: { repo: ConversationRepo; outbox: OutboundQueue; audit: AuditLog; llm: LlmPort; clock: Clock; config: AppConfig; relay: Relay }) {}

  private vars() { return { clinic_name: this.d.config.settings.clinic_name }; }

  private async say(conv: Conversation, key: keyof AppConfig["messages"] | { raw: string }) {
    const text = typeof key === "string" ? render(this.d.config.messages[key], this.vars()) : key.raw;
    await this.d.outbox.enqueue({ kind: "text", to: conv.phone, body: text, conversationId: conv.id });
    await this.d.repo.appendMessage(conv.id, { direction: "out", text, at: this.d.clock.now() });
  }

  private isUrgentByKeyword(text: string): boolean {
    const t = text.toLowerCase();
    return this.d.config.settings.urgent_triggers.some(k => t.includes(k.toLowerCase()));
  }

  private async handoff(conv: Conversation, lastText: string, alreadyReplied: boolean) {
    if (!alreadyReplied) await this.say(conv, "handoff");
    await this.d.relay.openHandoff(conv, lastText, false);
    await this.d.audit.record({ conversationId: conv.id, type: "handoff", data: { lastText } });
  }

  async handlePatientMessage(msg: InboundMessage): Promise<void> {
    const phone = normalisePhone(msg.from);
    const now = this.d.clock.now();
    const conv = (await this.d.repo.getByPhone(phone)) ?? (await this.d.repo.create(phone));
    // History is read BEFORE storing the new message so the LLM does not see it twice.
    const history = await this.d.repo.recentMessages(conv.id, this.d.config.settings.history_turns_for_llm);
    await this.d.repo.appendMessage(conv.id, { direction: "in", text: msg.text, externalId: msg.externalId, at: now });
    conv.lastPatientAt = now;

    if (conv.mode === "closed") conv.mode = "bot";
    if (conv.mode === "human") {
      const idleMs = this.d.config.settings.human_idle_hours * 3600_000;
      const since = conv.lastHumanAt ? now.getTime() - conv.lastHumanAt.getTime() : Infinity;
      if (since < idleMs) {
        if (this.isUrgentByKeyword(msg.text)) {
          // Keyword check only (no LLM in human mode): emergency advice now, and make sure a doctor hears it.
          await this.say(conv, "emergency");
          await this.d.relay.escalateUrgent(conv, msg.text);
          await this.d.audit.record({ conversationId: conv.id, type: "urgent", data: { text: msg.text } });
        } else if (conv.claimedBy) {
          await this.d.relay.forwardPatientMessage(conv, msg.text);
        } else {
          await this.d.repo.save(conv);
          await this.d.audit.record({ conversationId: conv.id, type: "held_pending_doctor" });
        }
        return;
      }
      await this.d.relay.releaseIdle(conv);
    }

    let intent: Intent;
    if (this.isUrgentByKeyword(msg.text)) {
      intent = "urgent";
    } else {
      try {
        intent = (await this.d.llm.classifyIntent({ history, message: msg.text })).intent;
      } catch (e) {
        intent = "other";
        await this.d.audit.record({ conversationId: conv.id, type: "llm_error", data: { stage: "classify", error: String(e) } });
      }
    }
    await this.d.audit.record({ conversationId: conv.id, type: "intent", data: { intent } });

    switch (intent) {
      case "urgent": {
        await this.say(conv, "emergency");
        await this.d.relay.openHandoff(conv, msg.text, true);
        await this.d.audit.record({ conversationId: conv.id, type: "urgent", data: { text: msg.text } });
        return;
      }
      case "faq": {
        let faqId: string | null = null;
        try { faqId = (await this.d.llm.selectFaq({ faq: this.d.config.faq, message: msg.text })).faqId; }
        catch (e) { await this.d.audit.record({ conversationId: conv.id, type: "llm_error", data: { stage: "faq", error: String(e) } }); }
        const entry = this.d.config.faq.find(f => f.id === faqId);
        if (entry) {
          const intro = this.d.config.messages.faq_intro ? render(this.d.config.messages.faq_intro, this.vars()) + "\n" : "";
          await this.say(conv, { raw: intro + entry.answer });
          await this.d.audit.record({ conversationId: conv.id, type: "faq_answered", data: { faqId } });
        } else {
          await this.say(conv, "menu");
          await this.d.audit.record({ conversationId: conv.id, type: "faq_none" });
        }
        conv.otherCount = 0;
        await this.d.repo.save(conv);
        return;
      }
      case "book_visit":
      case "reschedule_or_cancel": {
        await this.say(conv, "booking_handoff");
        await this.handoff(conv, msg.text, true);
        return;
      }
      case "talk_to_human": {
        await this.handoff(conv, msg.text, false);
        return;
      }
      case "other": {
        conv.otherCount += 1;
        if (conv.otherCount >= 2) { await this.handoff(conv, msg.text, false); return; }
        await this.say(conv, "menu");
        await this.d.repo.save(conv);
        return;
      }
    }
  }

  /** Coexistence echo. Dormant on the clinic's number (no Business app there); kept for numbers that have it. */
  async handleDoctorEcho(echo: DoctorEcho): Promise<void> {
    const conv = await this.d.repo.getByPhone(normalisePhone(echo.to));
    if (!conv) return;
    const now = this.d.clock.now();
    await this.d.repo.appendMessage(conv.id, { direction: "doctor", text: echo.text, externalId: echo.externalId, at: now });
    if (echo.text.trim().toLowerCase() === "#bot") {
      conv.mode = "bot"; conv.otherCount = 0;
      await this.d.repo.save(conv);
      await this.d.audit.record({ conversationId: conv.id, type: "doctor_resumed_bot" });
      return;
    }
    conv.mode = "human"; conv.lastHumanAt = now;
    await this.d.repo.save(conv);
    await this.d.audit.record({ conversationId: conv.id, type: "doctor_took_over" });
  }
}
