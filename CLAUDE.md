# CLAUDE.md — housecall-bot

You are helping doctors maintain a WhatsApp intake bot. Read `README.md` first.

## Rules
- `config/` is data. `src/core` is logic with no I/O. `src/adapters` talks to the outside world. Keep it that way.
- Never call Meta, Plato, Postgres or Anthropic from `src/core`. Use the interfaces in `src/core/ports.ts`.
- Never hard-code patient-facing text in `src/`. Add it to `config/messages.yaml`.
- Never commit secrets. They live in Render environment variables.
- Before any push: `npm test && npm run typecheck && npm run check`.
- New behaviour gets a scenario test in `test/core/services/engine.test.ts` (or `relay.test.ts` beside it for doctor-relay behaviour) using the fakes in `test/support/fakes.ts`. Test files mirror `src/`.
- Tests use `test/fixtures/config/`, not the live `config/`. Editing the clinic's config never breaks tests; `npm run check` validates it.
- Spec and plans are kept outside the repo (`docs/private/superpowers/`, not committed). If you change behaviour, update the spec there.

## Common tasks
- Add an FAQ: edit `config/faq.md`, run `npm run check`, commit, push.
- Change a reply: edit `config/messages.yaml`.
- Change who is on duty: edit the roster (`config/roster.yaml` locally; the `roster.yaml` Secret File on Render) — not committed, real doctor names/numbers; see README "Doctor roster". In production, edit the Secret File and redeploy.
- Flip pilot → live: `booking_mode: auto` in `config/settings.yaml` (phase 2+).
- "Why didn't the bot reply?": query `audit_events` for the conversation (see `docs/runbook.md`).
- Doctor cannot take or reply to a patient: their number must be in the roster (`config/roster.yaml` locally; the `roster.yaml` Secret File on Render); see `docs/runbook.md` → relay sections.
