import { describe, expect, it } from "vitest";
import { computePortfolioAllocation } from "../src/portfolioAllocation.js";

// User's exact rule (session 2026-08-09): "If XMR is gold and XAUT is blue
// -100% portfolio goes to XMR, if XAUT gold and XMR is blue - 100% portfolio
// goes towards XAUT. If both are gold, 50% goes towards each XMR and XAUT,
// if both are blue 100% goes towards bitcoin." "gold" = orange regime,
// "blue" = anything else (navy or gray).
describe("computePortfolioAllocation", () => {
  it("XAUT gold, XMR blue (navy) -> 100% XAUT, 0% XMR", () => {
    const result = computePortfolioAllocation({ xautRegime: "orange", xmrRegime: "navy" });
    expect(result).toEqual({ xaut: 1, xmr: 0 });
  });

  it("XMR gold, XAUT blue (navy) -> 100% XMR, 0% XAUT", () => {
    const result = computePortfolioAllocation({ xautRegime: "navy", xmrRegime: "orange" });
    expect(result).toEqual({ xaut: 0, xmr: 1 });
  });

  it("both gold -> 50/50", () => {
    const result = computePortfolioAllocation({ xautRegime: "orange", xmrRegime: "orange" });
    expect(result).toEqual({ xaut: 0.5, xmr: 0.5 });
  });

  it("both blue (navy) -> 0/0, effectively 100% BTC", () => {
    const result = computePortfolioAllocation({ xautRegime: "navy", xmrRegime: "navy" });
    expect(result).toEqual({ xaut: 0, xmr: 0 });
  });

  it("treats gray the same as blue/navy - not strong enough to hold", () => {
    const xautGoldXmrGray = computePortfolioAllocation({ xautRegime: "orange", xmrRegime: "gray" });
    expect(xautGoldXmrGray).toEqual({ xaut: 1, xmr: 0 });

    const bothGray = computePortfolioAllocation({ xautRegime: "gray", xmrRegime: "gray" });
    expect(bothGray).toEqual({ xaut: 0, xmr: 0 });
  });
});
