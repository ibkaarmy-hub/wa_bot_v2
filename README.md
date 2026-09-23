# housecall-bot

WhatsApp intake bot for Urgent Care At Home. Answers approved FAQs, detects emergencies, and hands everything else to the on-duty doctors. Phase 2 adds booking into Plato.

Design spec: kept outside the repo (`docs/private/superpowers/specs/2026-09-16-housecall-bot-design.md`, not committed). Runbook: `docs/runbook.md`.

## What you can safely change (no coding)

Everything in `config/`:

| File | What it controls |
|---|---|
| `config/roster.yaml` | Doctors, their WhatsApp numbers, duty days, Plato calendar IDs, visit length and travel buffer. **Not committed** — see "Doctor roster" below |
| `config/faq.md` | Approved questions and answers. Add a `## id` heading, a `**Q:**` line, then the answer |
| `config/messages.yaml` | Every sentence the bot sends. `{clinic_name}` is substituted automatically |
| `config/settings.yaml` | `booking_mode`, timeouts, emergency trigger words, template names |
| `config/messages.yaml` → `doctor_*` keys | What doctors see on their phone when taking a patient, and the two notices patients get |

Check your edit before pushing: `npm run check`. Then `git commit` and `git push` — Render redeploys in ~2 minutes. If the config is invalid the deploy fails and the previous version keeps running.

### Doctor roster

`config/roster.yaml` has real doctor names and WhatsApp numbers, so it is never committed (it's in `.gitignore`). `config/roster.example.yaml` — placeholders only — is what's in git.

- **Local runs:** copy `config/roster.example.yaml` to `config/roster.yaml` and fill in the real doctors. If `config/roster.yaml` is missing, `npm run check` validates the example instead; `npm run dev` needs the real file (copy the example).
- **Production (Render):** the real file is uploaded once as a Render **Secret File** named `roster.yaml`. Render mounts it at `/etc/secrets/roster.yaml`, and the `ROSTER_FILE` environment variable (set in `render.yaml`) points the bot at it. To change the roster in production: Render dashboard → Environment → Secret Files → edit `roster.yaml` → redeploy.

## Running locally

```bash
nvm use            # Node 22
npm install
docker compose up -d db
cp .env.example .env   # fill in values
set -a && . ./.env && set +a
npm run dev
```

Tests: `npm test` (Postgres tests run only when `DATABASE_URL_TEST` is set, e.g. `postgres://housecall:housecall@localhost:5432/housecall`). The Anthropic SDK's structured-output helper builds its schemas from the `zod/v4` subpath (bundled with zod 3.25+), used only in `src/adapters/claude/llm.ts`; the rest of the code uses top-level zod.

## How doctors use it

Doctors reply from their own WhatsApp, to the clinic number. When the bot hands a patient over, every on-duty doctor gets an alert with a code. `#take CODE` takes the patient; ordinary replies then go to that patient; `#bot` hands back; `#list` and `#help` explain the rest. Full detail in `docs/runbook.md` → "How doctors take over a chat".

## Local smoke test (no Meta or Anthropic account needed)

1. `docker compose up -d db`, then in one terminal `npm run smoke:stub` (a local stand-in for Meta that records every send).
2. In another terminal start the app with the stub as its Meta endpoint, e.g.
   `META_GRAPH_BASE_URL=http://localhost:4010 META_ACCESS_TOKEN=x META_APP_SECRET=smoke-secret META_PHONE_NUMBER_ID=PN1 META_VERIFY_TOKEN=vt ANTHROPIC_API_KEY=x DATABASE_URL=postgres://housecall:housecall@localhost:5432/housecall npm run dev`
   (with a dummy `ANTHROPIC_API_KEY` the FAQ path exercises the LLM-failure fallback; use a real key to test classification).
3. Post signed webhooks: `META_APP_SECRET=smoke-secret npm run smoke:send -- patient 6591234567 "my father has chest pain"`; a doctor command from a roster number, e.g. `patient 6590000001 "#list"` (the relay treats roster senders as doctors); and `status <digits> delivered <id>`.
4. Watch the stub terminal for what the bot sent, and query `audit_events` (see `docs/runbook.md`).

## Environment variables (set in Render → Environment; never commit)

| Variable | Where it comes from | Rotate by |
|---|---|---|
| `DATABASE_URL` | Render Postgres internal URL (auto-linked by render.yaml; no TLS needed) | Render dashboard |
| `PGSSL` | Set to `require` only when connecting over Render's EXTERNAL URL (e.g. from your laptop) | — |
| `META_ACCESS_TOKEN` | Meta Business Settings → System Users → your system user → Generate token (permission `whatsapp_business_messaging`) | Generate new token, update env, redeploy |
| `META_APP_SECRET` | Meta App Dashboard → App settings → Basic | Reset in Meta, update env |
| `META_PHONE_NUMBER_ID` | Meta App Dashboard → WhatsApp → API Setup | n/a |
| `META_VERIFY_TOKEN` | Any random string you choose; also entered in Meta webhook config | Change both places |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys (clinic's own account with billing) | Create new key, delete old |
| `LLM_MODEL` | Optional, default `claude-opus-5` | — |
| `META_GRAPH_VERSION` | Optional, default `v21.0` | — |
| `META_GRAPH_BASE_URL` | Optional, default `https://graph.facebook.com`. Point at `http://localhost:4010` to use the local stub (`npm run smoke:stub`) | — |

## One-time Meta setup

1. In Meta Business Settings confirm the WhatsApp Business Account is owned by the clinic's business.
2. Create a Meta app (type Business), add the WhatsApp product, link the existing WhatsApp Business Account and phone number.
3. Create a system user with admin access to the app and the WhatsApp account; generate a permanent token → `META_ACCESS_TOKEN`.
4. Deploy this service first (so the URL exists), then in the app's WhatsApp → Configuration set the callback URL to `https://<render-url>/webhooks/meta` and the verify token to `META_VERIFY_TOKEN`. Subscribe to `messages`. (The Coexistence echo field in `settings.yaml` does not apply to this number; see step 7.)
5. Create and submit the utility template `doctor_alert` (language `en`, body: `New patient message — {{1}}`). Wait for approval before go-live.
6. Detach the previous CRM provider's app from the WhatsApp Business Account and cancel its subscription.
7. ~~Enable Coexistence so the number also runs in the WhatsApp Business app on the doctors' phones.~~ **Not possible on this number** — it is a Cloud API number and Coexistence cannot be added to one. Do not install the WhatsApp Business app with this number; it would deregister it from the API. Doctors will work through the relay described in the design spec §3.4 instead.

## Architecture in one paragraph

`src/core` is pure logic (conversation modes, intent routing, FAQ, hand-off) behind interfaces in `src/core/ports.ts`. `src/adapters` implements those interfaces: Fastify HTTP, Meta Cloud API, Anthropic, Postgres. Inbound webhooks are stored then processed one phone at a time; every outbound message goes through a Postgres outbox with retries. Single instance by design.

## Where things live

```
config/                  The clinic's settings, replies and FAQ. Only the roster example is committed.
migrations/              Database schema changes, applied automatically at startup.
scripts/                 Local helpers: fake Meta server and webhook sender for smoke tests.
src/
  main.ts                Starts the app and connects all the pieces.
  config/                Reads and checks the files in config/.
  core/                  The bot's decisions. No network or database here.
    ports.ts             The interfaces core uses to reach the outside world.
    services/engine.ts   Patient conversations: intent, FAQ answers, hand-off to a doctor.
    services/relay/      Doctor relay: alerts, #take/#bot/#list, passing messages both ways.
    lib/                 Small helpers: phone numbers, patient codes, text templates, who is on duty.
  adapters/              Talks to the outside world.
    http/                The web server Meta calls (routes in server.ts, signature check in middleware/).
    meta/                WhatsApp Cloud API: sending, parsing webhooks, checking signatures.
    claude/              Anthropic: intent and FAQ matching.
    postgres/            Database: conversations, outbox, audit log, migrations.
    workers/             Background loops: inbound queue, outbox sender, relay timer.
test/                    Same layout as src/. Shared fakes in test/support/, sample data in test/fixtures/.
docs/                    Runbook, design specs and plans.
```

## Personal data

Patient phone numbers and message text are stored in Render Postgres (encrypted at rest by Render). Plato remains the medical record. A retention job that trims addresses and old messages ships in phase 2; until then, treat the database as containing personal data under the PDPA and restrict Render dashboard access accordingly.
