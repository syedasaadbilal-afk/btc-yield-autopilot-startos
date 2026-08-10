import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY_CONFIG } from "@autopilot/shared";
import { planTrancheExecution, applyLegFallbackIfNeeded } from "../src/planTranche.js";

describe("planTrancheExecution", () => {
  it("produces the configured number of clips, evenly spaced across the window", () => {
    const plan = planTrancheExecution({
      trancheId: "t1",
      trancheWeight: 0.25,
      side: "buy_btc_with_xaut",
      scheduledStart: 1_000_000,
      config: DEFAULT_STRATEGY_CONFIG.execution,
    });
    expect(plan.clips).toHaveLength(DEFAULT_STRATEGY_CONFIG.execution.numClipsPerTranche);
    expect(plan.clips[0]!.scheduledAt).toBe(1_000_000);
    const last = plan.clips[plan.clips.length - 1]!;
    expect(last.scheduledAt).toBe(1_000_000 + DEFAULT_STRATEGY_CONFIG.execution.layeringWindowMs);
    expect(plan.clips.every((c) => c.status === "pending")).toBe(true);
  });

  it("does not set a leg fallback when depth is sufficient", () => {
    const plan = planTrancheExecution({
      trancheId: "t1",
      trancheWeight: 0.25,
      side: "buy_btc_with_xaut",
      scheduledStart: 0,
      config: DEFAULT_STRATEGY_CONFIG.execution,
    });
    const result = applyLegFallbackIfNeeded(
      plan,
      DEFAULT_STRATEGY_CONFIG.execution.legFallback.minRatioDepthUsd * 2,
      DEFAULT_STRATEGY_CONFIG.execution
    );
    expect(result.legFallback).toBeUndefined();
  });

  it("falls back to BTC/USD + XAUT/USD legs when tBTC:XAUT depth is too thin", () => {
    const plan = planTrancheExecution({
      trancheId: "t1",
      trancheWeight: 0.5,
      side: "sell_btc_for_xaut",
      scheduledStart: 0,
      config: DEFAULT_STRATEGY_CONFIG.execution,
    });
    const result = applyLegFallbackIfNeeded(
      plan,
      DEFAULT_STRATEGY_CONFIG.execution.legFallback.minRatioDepthUsd / 2,
      DEFAULT_STRATEGY_CONFIG.execution
    );
    expect(result.legFallback).toBeDefined();
    expect(result.legFallback!.btcUsdSymbol).toBe("tBTCUSD");
    expect(result.legFallback!.xautUsdSymbol).toBe("tXAUT:USD");
  });
});
