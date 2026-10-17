import { describe, expect, it } from "vitest";
import { summarizeFills } from "../src/execute.js";

describe("summarizeFills", () => {
  it("summarises only asset-leg orders with a true weighted average price", () => {
    const fills = [
      { symbol: "tBTCUST", action: "sell" as const, base: 0.02, price: 100_000 },
      { symbol: "tXMRUST", action: "buy" as const, base: 6, price: 320 },
      { symbol: "tXMRUST", action: "buy" as const, base: 6.25, price: 328 },
    ];
    const s = summarizeFills(fills, "tXMRUST")!;
    expect(s.orderCount).toBe(2);
    expect(s.assetAmount).toBeCloseTo(12.25);
    expect(s.quoteUsd).toBeCloseTo(6 * 320 + 6.25 * 328);
    expect(s.avgPrice).toBeCloseTo((6 * 320 + 6.25 * 328) / 12.25);
  });

  it("returns null when no asset order filled", () => {
    expect(summarizeFills([], "tXMRUST")).toBeNull();
    expect(summarizeFills(undefined, "tXMRUST")).toBeNull();
  });
});
