import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseWebhook } from "../../../src/adapters/meta/parse.js";

const load = (n: string) => JSON.parse(readFileSync(`test/fixtures/meta/${n}.json`, "utf8"));

describe("parseWebhook", () => {
  it("parses a patient text message", () => {
    const [ev] = parseWebhook(load("text-message"), "smb_message_echoes");
    expect(ev).toEqual({ type: "patient_message", message: { externalId: "wamid.ABC", from: "6591234567", text: "what are your hours", at: new Date(1758000000 * 1000) } });
  });
  it("parses a delivery status", () => {
    const [ev] = parseWebhook(load("status"), "smb_message_echoes");
    expect(ev).toEqual({ type: "status", externalId: "wamid.OUT1", status: "delivered", recipient: "6591234567" });
  });
  it("parses a coexistence echo using the configured field", () => {
    const [ev] = parseWebhook(load("echo"), "smb_message_echoes");
    expect(ev).toEqual({ type: "doctor_echo", echo: { externalId: "wamid.ECHO1", to: "6591234567", text: "Hi, Dr A here", at: new Date(1758000020 * 1000) } });
  });
  it("marks non-text messages as ignored with a reason", () => {
    const body = load("text-message");
    body.entry[0].changes[0].value.messages[0] = { from: "6591234567", id: "wamid.IMG", timestamp: "1", type: "image", image: { id: "x" } };
    expect(parseWebhook(body, "smb_message_echoes")).toEqual([{ type: "ignored", reason: "unsupported message type image (wamid.IMG)" }]);
  });
  it("returns [] for an unrelated object", () => { expect(parseWebhook({ object: "page" }, "smb_message_echoes")).toEqual([]); });
});
