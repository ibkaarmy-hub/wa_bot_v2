import { describe, it, expect } from "vitest";
import { CODE_ALPHABET, generateCode, looksLikeCode } from "../../../src/core/lib/codes.js";

describe("patient codes", () => {
  it("uses an alphabet with no vowels, no Y, and no I/L/O/0/1", () => {
    expect(CODE_ALPHABET).toBe("BCDFGHJKMNPQRSTVWXZ23456789");
    for (const ch of "AEIOUYIL01") expect(CODE_ALPHABET.includes(ch)).toBe(false);
  });
  it("generates three characters from the alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const c = generateCode();
      expect(c).toHaveLength(3);
      for (const ch of c) expect(CODE_ALPHABET.includes(ch)).toBe(true);
    }
  });
  it("is deterministic given an rng", () => {
    expect(generateCode(() => 0)).toBe("BBB");
    expect(generateCode(() => 0.999999)).toBe("999");
  });
  it("recognises code-shaped tokens case-insensitively and rejects others", () => {
    expect(looksLikeCode("p7k")).toBe(true);
    expect(looksLikeCode("P7K")).toBe(true);
    expect(looksLikeCode("yes")).toBe(false);   // vowel
    expect(looksLikeCode("P7")).toBe(false);
    expect(looksLikeCode("P7K2")).toBe(false);
    expect(looksLikeCode("#bot")).toBe(false);
  });
});
