import type { StrategyConfig, TrancheExecutionPlan, OrderClip } from "@autopilot/shared";

export interface PlanTrancheInput {
  trancheId: string;
  trancheWeight: number;
  side: "buy_btc_with_xaut" | "sell_btc_for_xaut";
  scheduledStart: number;
  config: StrategyConfig["execution"];
}

/**
 * Pure planner: builds the clip schedule for one tranche, evenly spaced across
 * the layering window (design doc Section 8 - "N equal clips spread over a
 * bounded time window"). Does not know about live order-book depth; that's
 * applied per-clip at placement time via sizeClipAgainstDepth, in the
 * bitfinex-client package, right before each clip actually goes out.
 */
export function planTrancheExecution(input: PlanTrancheInput): TrancheExecutionPlan {
  const { numClipsPerTranche, layeringWindowMs, maxFractionOfBookDepthPerClip } = input.config;
  const clips: OrderClip[] = [];
  for (let i = 0; i < numClipsPerTranche; i++) {
    const offset =
      numClipsPerTranche === 1 ? 0 : (layeringWindowMs * i) / (numClipsPerTranche - 1);
    clips.push({
      clipIndex: i,
      scheduledAt: input.scheduledStart + offset,
      maxFractionOfBookDepth: maxFractionOfBookDepthPerClip,
      status: "pending",
    });
  }

  return {
    trancheId: input.trancheId,
    trancheWeight: input.trancheWeight,
    side: input.side,
    windowMs: layeringWindowMs,
    numClips: numClipsPerTranche,
    clips,
  };
}

/**
 * Applies the leg fallback (design doc Section 8): if available depth on
 * tBTC:XAUT is too thin even after slicing, trade the two legs (BTC/USD,
 * XAUT/USD) instead of forcing size through the thin cross pair.
 */
export function applyLegFallbackIfNeeded(
  plan: TrancheExecutionPlan,
  ratioBookDepthUsd: number,
  config: StrategyConfig["execution"]
): TrancheExecutionPlan {
  if (!config.legFallback.enabled) return plan;
  if (ratioBookDepthUsd >= config.legFallback.minRatioDepthUsd) return plan;
  return {
    ...plan,
    legFallback: {
      reason: `tBTC:XAUT depth $${ratioBookDepthUsd.toFixed(0)} below minimum $${config.legFallback.minRatioDepthUsd}`,
      btcUsdSymbol: config.legFallback.btcUsdSymbol,
      xautUsdSymbol: config.legFallback.xautUsdSymbol,
    },
  };
}
