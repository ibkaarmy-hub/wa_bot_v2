// Post a signed, Meta-shaped webhook to the local service.
// Usage:
//   node scripts/send-webhook.mjs patient <fromDigits> "<text>" [messageId]
//   node scripts/send-webhook.mjs echo <toDigits> "<text>" [messageId]        (Coexistence doctor echo)
//   node scripts/send-webhook.mjs status <recipientDigits> delivered <messageId>
//   (a "patient" event from a roster number is a doctor command, e.g. "#take P7K")
// Env: META_APP_SECRET (required), WEBHOOK_URL (default http://localhost:3000/webhooks/meta),
//      META_PHONE_NUMBER_ID (default PN1), ECHO_FIELD (default smb_message_echoes), BAD_SIGNATURE=1 to send a wrong signature.
import { createHmac } from "node:crypto";
const [kind, number, text, idArg] = process.argv.slice(2);
const secret = process.env.META_APP_SECRET;
if (!secret || !kind || !number) { console.error("usage: see header of this file; META_APP_SECRET required"); process.exit(2); }
const url = process.env.WEBHOOK_URL ?? "http://localhost:3000/webhooks/meta";
const pnid = process.env.META_PHONE_NUMBER_ID ?? "PN1";
const ts = String(Math.floor(Date.now() / 1000));
const id = idArg ?? `wamid.local.${Date.now()}`;
const meta = { display_phone_number: "6590000000", phone_number_id: pnid };
let field, value;
if (kind === "patient") {
  field = "messages";
  value = { messaging_product: "whatsapp", metadata: meta, contacts: [{ profile: { name: "Smoke Tester" }, wa_id: number }], messages: [{ from: number, id, timestamp: ts, type: "text", text: { body: text ?? "" } }] };
} else if (kind === "echo") {
  field = process.env.ECHO_FIELD ?? "smb_message_echoes";
  value = { messaging_product: "whatsapp", metadata: meta, message_echoes: [{ from: meta.display_phone_number, to: number, id, timestamp: ts, type: "text", text: { body: text ?? "" } }] };
} else if (kind === "status") {
  field = "messages";
  value = { messaging_product: "whatsapp", metadata: meta, statuses: [{ id: idArg ?? "wamid.unknown", status: text ?? "delivered", timestamp: ts, recipient_id: number }] };
} else { console.error(`unknown kind ${kind}`); process.exit(2); }
const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "WABA_LOCAL", changes: [{ field, value }] }] });
const sig = "sha256=" + (process.env.BAD_SIGNATURE ? "0".repeat(64) : createHmac("sha256", secret).update(body).digest("hex"));
const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body });
console.log(`${kind} ${number} id=${id} -> HTTP ${res.status} ${await res.text()}`);
