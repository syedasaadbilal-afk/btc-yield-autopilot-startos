import { describe, expect, it } from "vitest";
import { computeBtcEquivalentNav } from "../src/nav.js";

describe("computeBtcEquivalentNav", () => {
  it("returns btcHeld unchanged when nothing is held in XAUT", () => {
    expect(computeBtcEquivalentNav(3, 0, 15)).toBe(3);
  });

  it("converts xautHeld back to BTC using the ratio (XAUT per BTC)", () => {
    // 30 XAUT at a ratio of 15 XAUT/BTC = 2 BTC-equivalent.
    expect(computeBtcEquivalentNav(0, 30, 15)).toBe(2);
  });

  it("sums both legs when partially rotated", () => {
    expect(computeBtcEquivalentNav(1, 15, 15)).toBe(2);
  });
});
