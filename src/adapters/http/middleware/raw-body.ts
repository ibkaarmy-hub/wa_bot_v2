// src/adapters/http/middleware/raw-body.ts
// JSON body parser that also keeps the raw body, so the HMAC is computed over exactly what Meta sent.
import type { FastifyInstance } from "fastify";

declare module "fastify" { interface FastifyRequest { rawBody?: string } }

export function registerRawJsonParser(app: FastifyInstance): void {
  // Fastify ships a default JSON parser; it must be removed before registering ours.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    req.rawBody = body as string;
    try { done(null, JSON.parse(body as string)); }
    catch (e) {
      const err = e as Error & { statusCode?: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });
}
