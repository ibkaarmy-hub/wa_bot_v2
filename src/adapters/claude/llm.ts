// src/adapters/claude/llm.ts
import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod/v4";
import type { FaqEntry, Intent, LlmPort, StoredMessage } from "../../core/ports.js";

export class LlmRefusedError extends Error {}

const INTENTS = ["book_visit", "faq", "reschedule_or_cancel", "urgent", "talk_to_human", "other"] as const;
const IntentSchema = z.object({ intent: z.enum(INTENTS), confidence: z.number().min(0).max(1) });
const FaqSchema = z.object({ faq_id: z.string().nullable() });

export class ClaudeLlm implements LlmPort {
  private system: string;
  constructor(private opts: { client: Anthropic; model: string; clinicName: string; faq: FaqEntry[] }) {
    const faqList = opts.faq.map(f => `- id: ${f.id}\n  question: ${f.question}`).join("\n");
    this.system = [
      `You are the WhatsApp intake assistant for ${opts.clinicName}, a home-visit medical practice in Singapore.`,
      `You never give medical advice. You only classify messages and match them to approved FAQ entries.`,
      ``,
      `Intents:`,
      `- book_visit: wants a doctor to visit, asks for an appointment, describes symptoms wanting care.`,
      `- reschedule_or_cancel: changes or cancels an existing visit.`,
      `- faq: asks about hours, fees, areas, payment, preparation, or how the service works.`,
      `- urgent: life-threatening symptoms (chest pain, breathing difficulty, unresponsive, heavy bleeding, stroke signs, seizure).`,
      `- talk_to_human: explicitly asks for a person or doctor to reply.`,
      `- other: greetings, thanks, unclear, or unrelated.`,
      ``,
      `Approved FAQ entries (return exactly one id, or null if none matches):`,
      faqList,
    ].join("\n");
  }

  private async parse<T>(schema: z.ZodType<T>, user: string): Promise<T> {
    const res = await this.opts.client.messages.parse({
      model: this.opts.model,
      max_tokens: 256,
      system: [{ type: "text", text: this.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
      output_config: { effort: "low", format: zodOutputFormat(schema) },
    });
    if (res.stop_reason === "refusal" || res.parsed_output == null) {
      throw new LlmRefusedError(`stop_reason=${res.stop_reason}`);
    }
    return res.parsed_output as T;
  }

  async classifyIntent({ history, message }: { history: StoredMessage[]; message: string }): Promise<{ intent: Intent; confidence: number }> {
    const hist = history.map(h => `${h.direction === "in" ? "Patient" : h.direction === "out" ? "Assistant" : "Doctor"}: ${h.text}`).join("\n");
    const user = `Recent conversation:\n${hist || "(none)"}\n\nNew patient message:\n${message}\n\nClassify the new message.`;
    return this.parse(IntentSchema, user);
  }

  async selectFaq({ faq, message }: { faq: FaqEntry[]; message: string }): Promise<{ faqId: string | null }> {
    const { faq_id } = await this.parse(FaqSchema, `Patient message:\n${message}\n\nWhich approved FAQ id answers it? Return null if none clearly does.`);
    return { faqId: faq_id && faq.some(f => f.id === faq_id) ? faq_id : null };
  }
}
