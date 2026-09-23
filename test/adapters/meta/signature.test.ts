import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifySignature } from "../../../src/adapters/meta/signature.js";

const secret = "s3cret"; const body = '{"a":1}';
const good = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

describe("verifySignature", () => {
  it("accepts a correct signature", () => { expect(verifySignature(body, good, secret)).toBe(true); });
  it("rejects a wrong signature, wrong prefix, or missing header", () => {
    expect(verifySignature(body, "sha256=" + "0".repeat(64), secret)).toBe(false);
    expect(verifySignature(body, good.replace("sha256=", "sha1="), secret)).toBe(false);
    expect(verifySignature(body, undefined, secret)).toBe(false);
  });
  it("rejects a tampered body", () => { expect(verifySignature('{"a":2}', good, secret)).toBe(false); });
  it("returns false, never throws, for a 64-char non-hex header", () => {
    expect(verifySignature(body, "sha256=" + "g".repeat(64), secret)).toBe(false);
    expect(verifySignature(body, good.slice(0, -1) + "z", secret)).toBe(false);
  });
});
