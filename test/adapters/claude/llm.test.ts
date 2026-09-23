import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { ClaudeLlm, LlmRefusedError } from "../../../src/adapters/claude/llm.js";

const faq = [{ id: "hours", question: "Hours?", answer: "9-9" }, { id: "fees", question: "Cost?", answer: "$180" }];

function stubClient(parsed: unknown, stop = "end_turn") {
  const calls: any[] = [];
  const client = { messages: { parse: async (params: any) => { calls.push(params); return { parsed_output: parsed, stop_reason: stop }; } } } as unknown as Anthropic;
  return { client, calls };
}

describe("ClaudeLlm", () => {
  it("classifies intent with a cached system prompt and structured output", async () => {
    const { client, calls } = stubClient({ intent: "faq", confidence: 0.92 });
    const llm = new ClaudeLlm({ client, model: "claude-opus-5", clinicName: "UCAH", faq });
    const res = await llm.classifyIntent({ history: [{ direction: "in", text: "hi", at: new Date() }], message: "what time do you open" });
    expect(res).toEqual({ intent: "faq", confidence: 0.92 });
    const p = calls[0];
    expect(p.model).toBe("claude-opus-5");
    expect(p.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(p.system[0].text).toContain("UCAH");
    expect(p.output_config.format).toBeDefined();
    expect(p.output_config.effort).toBe("low");
    expect(p.messages.at(-1).content).toContain("what time do you open");
  });
  it("selects an FAQ id or null", async () => {
    const { client } = stubClient({ faq_id: "fees" });
    const llm = new ClaudeLlm({ client, model: "claude-opus-5", clinicName: "UCAH", faq });
    expect(await llm.selectFaq({ faq, message: "how much" })).toEqual({ faqId: "fees" });
    const { client: c2 } = stubClient({ faq_id: "not-a-real-id" });
    const llm2 = new ClaudeLlm({ client: c2, model: "claude-opus-5", clinicName: "UCAH", faq });
    expect(await llm2.selectFaq({ faq, message: "x" })).toEqual({ faqId: null });
  });
  it("throws on refusal or unparseable output", async () => {
    const { client } = stubClient(null, "refusal");
    const llm = new ClaudeLlm({ client, model: "claude-opus-5", clinicName: "UCAH", faq });
    await expect(llm.classifyIntent({ history: [], message: "x" })).rejects.toBeInstanceOf(LlmRefusedError);
  });
});
