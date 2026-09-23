// src/adapters/http/server.ts
// Routes only. Body parsing and the signature check live in ./middleware.
import Fastify, { type FastifyInstance } from "fastify";
import { parseWebhook, type ParsedEvent } from "../meta/parse.js";
import type { InboundWorker } from "../workers/inbound.js";
import { registerRawJsonParser } from "./middleware/raw-body.js";
import { verifyMetaSignature } from "./middleware/verify-signature.js";

export function buildServer(d: { appSecret: string; verifyToken: string; echoField: string; worker: Pick<InboundWorker, "accept">; log: (msg: string, extra?: unknown) => void }): FastifyInstance {
  const app = Fastify({ logger: false });

  registerRawJsonParser(app);   // keeps req.rawBody for the signature check

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/webhooks/meta", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === d.verifyToken && q["hub.challenge"]) {
      return reply.code(200).type("text/plain").send(q["hub.challenge"]);
    }
    return reply.code(403).send("forbidden");
  });

  app.post("/webhooks/meta", { preHandler: verifyMetaSignature({ appSecret: d.appSecret, log: d.log }) }, async (req, reply) => {
    let events: ParsedEvent[];
    try { events = parseWebhook(req.body, d.echoField); }
    catch (e) {
      d.log("webhook payload malformed", { error: String(e) });
      return reply.code(200).send("ok");
    }
    try {
      // accept() persists and schedules; it does not wait for processing.
      await d.worker.accept(events, req.body);
    } catch (e) {
      d.log("webhook processing error", { error: String(e) });
      return reply.code(500).send("error");
    }
    return reply.code(200).send("ok");
  });

  return app;
}
