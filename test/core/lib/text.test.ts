import { describe, it, expect } from "vitest";
import { render } from "../../../src/core/lib/text.js";

describe("render", () => {
  it("substitutes placeholders", () => {
    expect(render("Hi {name}, {clinic_name} here", { name: "Jane", clinic_name: "UCAH" }))
      .toBe("Hi Jane, UCAH here");
  });
  it("throws on a missing variable so config errors surface early", () => {
    expect(() => render("Hi {name}", {})).toThrow(/missing variable "name"/);
  });
});
