// src/adapters/http/middleware/verify-signature.ts
// Meta X-Hub-Signature-256 check, as a Fastify preHandler for the webhook POST.
// preHandler runs after body parsing, so req.rawBody (set by raw-body.ts) is available.
import type { FastifyReply, FastifyRequest } from "fastify";
import { verifySignature } from "../../meta/signature.js";

export function verifyMetaSignature(d: { appSecret: string; log: (msg: string, extra?: unknown) => void }) {
  return async function verifyMetaSignatureHook(req: FastifyRequest, reply: FastifyReply) {
    const sig = req.headers["x-hub-signature-256"];
    if (!verifySignature(req.rawBody ?? "", typeof sig === "string" ? sig : undefined, d.appSecret)) {
      d.log("webhook signature rejected");
      return reply.code(401).send("bad signature");
    }
  };
}
