import { describe, expect, it } from "vitest";
import { deriveAssetHolds } from "../src/assetHolds.js";
import type { Trade } from "../src/trade.js";

function trade(p: Partial<Trade> & { id: string; openedAt: number }): Trade {
  return {
    runMode: "LIVE",
    targetPosition: "long",
    btcCapitalAtOpen: 1,
    riskFractionOfCapital: 0,
    stopLossRatio: 0,
    firstTargetRatio: 0,
    status: "closed_win",
    trancheExecutionPlanIds: [],
    ...p,
  };
}

describe("deriveAssetHolds", () => {
  it("derives a closed hold + an open hold (XMR-like: bootstrap, real BTC period, now in asset)", () => {
    const trades = [
      trade({ id: "b", openedAt: 1, closedAt: 10, entryPrice: 170, exitPrice: 180, notes: "Bootstrap-inferred" }),
      // exited gold at r=150 (price rose), BTC period, re-entered at 152
      trade({ id: "t1", openedAt: 20, closedAt: 30, entryPrice: 150, exitPrice: 152, btcCapitalAtOpen: 2 }),
    ];
    const holds = deriveAssetHolds(trades);
    expect(holds).toHaveLength(2);
    // hold 1: entered gold at 180 (asset/BTC) day 10, exited at 150 day 20: price up 20%
    expect(holds[0]).toMatchObject({ entryAt: 10, exitAt: 20, entryPrice: 180, exitPrice: 150 });
    expect(holds[0]!.pnl).toBeCloseTo(2 - 2 / 1.2, 9);
    // hold 2: open, entered day 30
    expect(holds[1]).toMatchObject({ entryAt: 30, entryPrice: 152 });
    expect(holds[1]!.exitAt).toBeUndefined();
  });

  it("shows a hold with unknown entry and no PnL when the first real trade has no predecessor (XAUT-like)", () => {
    const trades = [trade({ id: "t1", openedAt: 20, status: "open", entryPrice: 17 })];
    const holds = deriveAssetHolds(trades);
    expect(holds).toHaveLength(1);
    expect(holds[0]!.entryAt).toBeUndefined();
    expect(holds[0]).toMatchObject({ exitAt: 20, exitPrice: 17 });
    expect(holds[0]!.pnl).toBeUndefined();
  });

  it("ignores cancelled trades and yields nothing for an empty or bootstrap-only open history", () => {
    expect(deriveAssetHolds([])).toEqual([]);
    expect(
      deriveAssetHolds([
        trade({ id: "c", openedAt: 1, status: "cancelled" }),
        trade({ id: "b", openedAt: 2, status: "open", notes: "Bootstrap-inferred" }),
      ])
    ).toEqual([]);
  });
});

describe("deriveAssetHolds actual vs signal prices", () => {
  it("uses actual fill prices for headline PnL and keeps signal PnL for comparison", () => {
    const mk = (o: Partial<import("../src/trade.js").Trade>) =>
      ({ runMode: "LIVE", targetPosition: "long", btcCapitalAtOpen: 1, riskFractionOfCapital: 0.01, stopLossRatio: 0, firstTargetRatio: 0, status: "closed_win", trancheExecutionPlanIds: [], ...o }) as import("../src/trade.js").Trade;
    const holds = deriveAssetHolds([
      mk({ id: "a", openedAt: 1, closedAt: 10, entryPrice: 100, exitPrice: 100, actualEntryPrice: 100, actualExitPrice: 101 }),
      mk({ id: "b", openedAt: 20, closedAt: 30, entryPrice: 90, exitPrice: 90, actualEntryPrice: 91, actualExitPrice: 90 }),
    ]);
    const h = holds.find((x) => x.id === "b")!;
    expect(h.pnlBasis).toBe("actual");
    expect(h.signalPnl).toBeCloseTo(1 - 1 / (101 / 91 > 0 ? 100 / 90 : 1), 6);
    expect(h.pnl).toBeCloseTo(1 - 1 / (101 / 91), 6);
    expect(h.pnl).not.toBeCloseTo(h.signalPnl!, 4);
  });
});
