# Runbook

All times Singapore. Logs and restarts: Render dashboard → housecall-bot.

## Bot is silent
1. Render dashboard → is the service Live? If not, open the latest deploy log; a `STARTUP FAILED — <file>: <problem>` line names the file and problem — fix and push. (`CONFIG ERROR` is what `npm run check` prints locally, not the deploy log.)
2. `curl https://<url>/healthz` → expect `{"ok":true}`.
3. Meta App Dashboard → WhatsApp → Configuration → webhook still subscribed to `messages`? Click Test. A `webhook signature rejected` log line means `META_APP_SECRET` is wrong.
4. In the database: `select * from inbound_events order by received_at desc limit 5;` If rows arrive but `processed_at` is null, check logs for `processing error`.
5. `select * from outbound_messages where status in ('pending','failed') order by id desc limit 10;` A `failed` row's `last_error` shows Meta's reason (401 → token expired, see below). Rows stuck in `sending` older than 2 minutes (e.g. after a crash mid-send) are re-queued automatically on the next tick.

## Meta shows webhook delivery failures (5xx)
The service deliberately returns 500 when it cannot store an incoming event (for example the database is unreachable) so Meta retries it later; duplicates are ignored by design. Check Render logs for `webhook processing error`. A malformed payload is acknowledged with 200 and logged as `webhook payload malformed`; an invalid JSON body gets 400.

## Meta token expired / 401 in last_error
Generate a new system-user token in Meta Business Settings, update `META_ACCESS_TOKEN` in Render → Environment, Save (auto-redeploys). Pending outbox rows retry automatically.

## How doctors take over a chat (relay)
Doctors work from their own WhatsApp. A hand-off sends every on-duty doctor the `doctor_alert` template with a 3-character patient code. From the doctor's phone, to the clinic number:
- `#take CODE` – take the patient; the bot goes quiet for them and replays what they said since the hand-off.
- Reply normally – it goes to your last patient. Start with the code (`P7K on my way`) to pick one of several.
- `#bot CODE` (or `#bot`) – hand back to the assistant.
- `#list` – your patients. `#help` – this list.
Texts are in `config/messages.yaml` (`doctor_*`, `bot_resumed`, `handoff_unclaimed`). Timing in `settings.yaml`: `handoff_realert_minutes` (URGENT re-alert; patient told to expect a call after double), `human_idle_hours` (bot resumes if the doctor goes quiet).
Write each doctor's `name` in the roster (`config/roster.yaml` locally; the `roster.yaml` Secret File on Render) as patients should see it, title included (e.g. `Dr Tan`).

The roster with the doctors' real names and numbers is not in the code repository — only a placeholder example is. To change it: Render dashboard → the service → Environment → Secret Files → edit `roster.yaml` → Save, then deploy. Editing there skips `npm run check`; a bad roster makes the new deploy fail at startup, and Render keeps the previous version running, so check the deploy log. The file committed to the repo (`config/roster.example.yaml`) is only an example and is never used in production.

## Bot replied while a doctor was handling it
The bot only stays quiet for a patient a doctor has **taken** (`#take`). Check `audit_events` for the conversation: `doctor_claimed` should precede the bot reply; `human_idle_resumed` means the doctor was quiet longer than `human_idle_hours`. If the doctor's number is not in the roster (`config/roster.yaml` locally; the `roster.yaml` Secret File on Render), their messages are treated as a patient's — add it.

## Doctor says their reply did not reach the patient
Look for `relay_window_closed` in `audit_events`. WhatsApp blocks free text to a patient who has not messaged in 24 hours; the doctor received a `doctor_window_closed` text. The patient must message first. A `doctor_command_rejected` event names why a command was refused (`unknown_code`, `taken_by_other`, `not_taken`, `no_active`, `not_holder`); a reply that starts with another patient's code is refused this way and relayed to nobody.

Meta may also accept an out-of-window message and report the failure later as a failed delivery status (a `delivery_status` audit row with status `failed`, e.g. error 131047) instead of rejecting the send. In that case no `relay_window_closed` is recorded yet and the doctor is not told, so check `delivery_status` rows too. They carry no conversation id; match them to the relay send by message id:
```sql
select o.id, o.to_phone, o.origin, a.created_at, a.data from audit_events a
join outbound_messages o on o.external_id = a.data->>'externalId'
where a.type = 'delivery_status' and a.data->>'status' = 'failed' and o.origin is not null
order by a.id desc limit 20;
```

## Relay audit types
`handoff_opened`, `handoff_realert` (`reason: "urgent"` when the patient sent an urgent keyword while waiting), `handoff_unclaimed`, `held_pending_doctor`, `doctor_claimed`, `doctor_released` (`reason`: `command` or `holder_left_roster`), `relay_in` (patient → doctor; `urgent: true` when forwarded as `URGENT P7K: …`), `relay_out` (doctor → patient), `doctor_command_rejected`, `relay_window_closed`, `human_idle_resumed`, and `relay_tick_error`: one pending conversation failed during a re-alert tick (the `error` field says why); the tick carried on with the others and retries this one next tick. Repeated `relay_tick_error` rows for the same conversation mean it is stuck; check the error and the outbox.

## After deploying the relay for the first time
Migration 003 hands every conversation that was in `human` mode under the old hand-off back to the bot (they have no code and nobody would be re-alerted).

During the deploy overlap the old instance keeps running for a short while and can still put a conversation into `human` mode without a code (after the migration has already run). Once the deploy has settled (old instance gone), run once:
```sql
update conversations set mode='bot', other_count=0 where mode='human' and code is null;
```

## Nobody took a hand-off
After `handoff_realert_minutes` every on-duty doctor gets the alert again marked URGENT (`handoff_realert`); after double that, the patient is told a doctor will contact them (`handoff_unclaimed`). The conversation stays takeable. If no alert arrived at all, check the `doctor_alert` template is approved and `outbound_messages` for `failed` rows.

## What did the bot do with patient X?
```sql
select a.created_at, a.type, a.data from audit_events a
join conversations c on c.id = a.conversation_id
where c.phone = '+6591234567' order by a.id;
```

## Flip pilot ↔ live (phase 2+)
Edit `config/settings.yaml` → `booking_mode`, `npm run check`, commit, push.

The go-live log and Meta account audit are kept outside the repo (`docs/private/`, not committed).
