import { describe, it, expect } from "vitest";
import { MetaMessaging, MetaSendError } from "../../../src/adapters/meta/client.js";

function fakeFetch(status: number, json: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("MetaMessaging", () => {
  it("sends a text message and returns the wamid", async () => {
    const { f, calls } = fakeFetch(200, { messages: [{ id: "wamid.X" }] });
    const m = new MetaMessaging({ accessToken: "tok", phoneNumberId: "PN1", fetchImpl: f });
    const res = await m.sendText("+6591234567", "hello");
    expect(res).toEqual({ id: "wamid.X" });
    expect(calls[0].url).toBe("https://graph.facebook.com/v21.0/PN1/messages");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      messaging_product: "whatsapp", recipient_type: "individual", to: "6591234567", type: "text", text: { preview_url: false, body: "hello" },
    });
  });
  it("honours a baseUrl override (local stub for smoke tests)", async () => {
    const { f, calls } = fakeFetch(200, { messages: [{ id: "wamid.L" }] });
    const m = new MetaMessaging({ accessToken: "tok", phoneNumberId: "PN1", fetchImpl: f, baseUrl: "http://localhost:4010" });
    await m.sendText("+65", "x");
    expect(calls[0].url).toBe("http://localhost:4010/v21.0/PN1/messages");
  });
  it("sends a template with body parameters", async () => {
    const { f, calls } = fakeFetch(200, { messages: [{ id: "wamid.T" }] });
    const m = new MetaMessaging({ accessToken: "tok", phoneNumberId: "PN1", fetchImpl: f });
    await m.sendTemplate("+6590000001", "doctor_alert", ["+65 9123 4567: chest pain"]);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      messaging_product: "whatsapp", to: "6590000001", type: "template",
      template: { name: "doctor_alert", language: { code: "en" }, components: [{ type: "body", parameters: [{ type: "text", text: "+65 9123 4567: chest pain" }] }] },
    });
  });
  it("throws a retryable error on 5xx/429 and non-retryable on 4xx", async () => {
    const m5 = new MetaMessaging({ accessToken: "t", phoneNumberId: "P", fetchImpl: fakeFetch(503, { error: "x" }).f });
    await expect(m5.sendText("+65", "a")).rejects.toMatchObject({ status: 503, retryable: true });
    const m4 = new MetaMessaging({ accessToken: "t", phoneNumberId: "P", fetchImpl: fakeFetch(400, { error: { message: "bad" } }).f });
    await expect(m4.sendText("+65", "a")).rejects.toBeInstanceOf(MetaSendError);
    await expect(m4.sendText("+65", "a")).rejects.toMatchObject({ status: 400, retryable: false });
  });
  it("wraps a network failure as a retryable MetaSendError with status 0", async () => {
    const f = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const m = new MetaMessaging({ accessToken: "t", phoneNumberId: "P", fetchImpl: f });
    await expect(m.sendText("+65", "a")).rejects.toMatchObject({ status: 0, retryable: true });
  });
  it("treats a 2xx with a non-JSON body as a non-retryable MetaSendError", async () => {
    const f = (async () => new Response("<html>oops</html>", { status: 200 })) as unknown as typeof fetch;
    const m = new MetaMessaging({ accessToken: "t", phoneNumberId: "P", fetchImpl: f });
    await expect(m.sendText("+65", "a")).rejects.toMatchObject({ status: 200, retryable: false });
  });
});
