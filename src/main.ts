// src/main.ts
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "./config/load.js";
import { Engine } from "./core/services/engine.js";
import { DoctorRelay } from "./core/services/relay/index.js";
import { buildServer } from "./adapters/http/server.js";
import { MetaMessaging } from "./adapters/meta/client.js";
import { ClaudeLlm } from "./adapters/claude/llm.js";
import { createPool } from "./adapters/postgres/pool.js";
import { runMigrations } from "./adapters/postgres/migrate.js";
import { PgAudit, PgConversationRepo, PgDoctorState, PgInboundEvents, PgOutbox } from "./adapters/postgres/repos.js";
import { InboundWorker } from "./adapters/workers/inbound.js";
import { OutboxWorker } from "./adapters/workers/outbox.js";
import { RelayWorker } from "./adapters/workers/relay.js";
import type { ConversationLock } from "./core/ports.js";

function env(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`Missing required environment variable ${name}`); process.exit(1); }
  return v;
}
const log = (msg: string, extra?: unknown) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...(extra ? { extra } : {}) }));

async function main() {
  const config = loadConfig(process.env.CONFIG_DIR ?? "./config", { rosterFile: process.env.ROSTER_FILE || undefined });   // throws with file + reason
  const pool = createPool(env("DATABASE_URL"));
  const applied = await runMigrations(pool);
  if (applied.length) log("migrations applied", applied);

  const repo = new PgConversationRepo(pool);
  const outbox = new PgOutbox(pool);
  const audit = new PgAudit(pool);
  const events = new PgInboundEvents(pool);
  const messaging = new MetaMessaging({ accessToken: env("META_ACCESS_TOKEN"), phoneNumberId: env("META_PHONE_NUMBER_ID"), graphVersion: process.env.META_GRAPH_VERSION, baseUrl: process.env.META_GRAPH_BASE_URL });
  const llm = new ClaudeLlm({ client: new Anthropic({ apiKey: env("ANTHROPIC_API_KEY") }), model: process.env.LLM_MODEL ?? "claude-opus-5", clinicName: config.settings.clinic_name, faq: config.faq });
  const clock = { now: () => new Date() };

  const doctorState = new PgDoctorState(pool);
  // The inbound worker is the lock, but the relay is constructed first; delegate lazily.
  let inbound!: InboundWorker;
  const lock: ConversationLock = { withConversation: (phone, fn) => inbound.withConversation(phone, fn) };
  const relay = new DoctorRelay({ repo, doctors: doctorState, outbox, audit, clock, config, lock });
  const engine = new Engine({ repo, outbox, audit, llm, clock, config, relay });
  inbound = new InboundWorker({ engine, relay, doctorPhones: new Set(config.roster.doctors.map(d => d.whatsapp)), events, audit, log });
  const outboxWorker = new OutboxWorker({
    outbox, messaging, audit, clock, log,
    onPermanentFailure: async row => { if (row.origin) await relay.handleRelayFailure(row.origin, row.conversationId); },
  });
  outboxWorker.start(500);
  const relayWorker = new RelayWorker({ relay, log });
  relayWorker.start(config.settings.relay_tick_seconds * 1000);

  const app = buildServer({ appSecret: env("META_APP_SECRET"), verifyToken: env("META_VERIFY_TOKEN"), echoField: config.settings.meta.echo_field, worker: inbound, log });
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: "0.0.0.0" });
  log("listening", { port, booking_mode: config.settings.booking_mode, doctors: config.roster.doctors.length, faq: config.faq.length });

  const shutdown = async () => { log("shutting down"); await outboxWorker.stop(); await relayWorker.stop(); await app.close(); await inbound.idle(); await pool.end(); process.exit(0); };
  process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
}

main().catch(e => { console.error(`STARTUP FAILED — ${(e as Error).message}`); process.exit(1); });
