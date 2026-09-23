import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildServer } from "../../../src/adapters/http/server.js";

const secret = "app-secret";
const sign = (body: string) => "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

function server() {
  const accepted: any[] = [];
  const app = buildServer({ appSecret: secret, verifyToken: "vt", echoField: "smb_message_echoes", worker: { accept: async (events, raw) => { accepted.push({ events, raw }); } }, log: () => {} });
  return { app, accepted };
}

describe("HTTP server", () => {
  it("health check", async () => {
    const { app } = server();
    const r = await app.inject({ method: "GET", url: "/healthz" });
    expect(r.statusCode).toBe(200); expect(r.json()).toEqual({ ok: true });
  });
  it("completes the Meta verification handshake", async () => {
    const { app } = server();
    const ok = await app.inject({ method: "GET", url: "/webhooks/meta?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=12345" });
    expect(ok.statusCode).toBe(200); expect(ok.body).toBe("12345");
    const bad = await app.inject({ method: "GET", url: "/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1" });
    expect(bad.statusCode).toBe(403);
  });
  it("rejects an unsigned or badly signed POST", async () => {
    const { app, accepted } = server();
    const body = readFileSync("test/fixtures/meta/text-message.json", "utf8");
    const r1 = await app.inject({ method: "POST", url: "/webhooks/meta", payload: body, headers: { "content-type": "application/json" } });
    expect(r1.statusCode).toBe(401);
    const r2 = await app.inject({ method: "POST", url: "/webhooks/meta", payload: body, headers: { "content-type": "application/json", "x-hub-signature-256": sign("other") } });
    expect(r2.statusCode).toBe(401);
    expect(accepted).toHaveLength(0);
  });
  it("accepts a signed POST, parses it, hands it to the worker, returns 200", async () => {
    const { app, accepted } = server();
    const body = readFileSync("test/fixtures/meta/text-message.json", "utf8");
    const r = await app.inject({ method: "POST", url: "/webhooks/meta", payload: body, headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) } });
    expect(r.statusCode).toBe(200);
    expect(accepted[0].events[0]).toMatchObject({ type: "patient_message", message: { externalId: "wamid.ABC" } });
  });
  it("returns 200 and logs when a signed payload is malformed", async () => {
    const logs: string[] = [];
    const app = buildServer({ appSecret: secret, verifyToken: "vt", echoField: "smb_message_echoes", worker: { accept: async () => {} }, log: (m) => { logs.push(m); } });
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [null] }] });
    const r = await app.inject({ method: "POST", url: "/webhooks/meta", payload: body, headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) } });
    expect(r.statusCode).toBe(200);
    expect(logs).toContain("webhook payload malformed");
  });
  it("returns 400 on an invalid JSON body", async () => {
    const { app } = server();
    const r = await app.inject({ method: "POST", url: "/webhooks/meta", payload: "{not json", headers: { "content-type": "application/json", "x-hub-signature-256": sign("{not json") } });
    expect(r.statusCode).toBe(400);
  });
  it("returns 500 when the worker fails, so Meta retries", async () => {
    const logs: string[] = [];
    const app = buildServer({ appSecret: secret, verifyToken: "vt", echoField: "smb_message_echoes", worker: { accept: async () => { throw new Error("db down"); } }, log: (m) => { logs.push(m); } });
    const body = readFileSync("test/fixtures/meta/text-message.json", "utf8");
    const r = await app.inject({ method: "POST", url: "/webhooks/meta", payload: body, headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) } });
    expect(r.statusCode).toBe(500);
    expect(logs).toContain("webhook processing error");
  });
});
