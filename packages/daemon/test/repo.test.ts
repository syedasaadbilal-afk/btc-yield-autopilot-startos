import { describe, expect, it, beforeEach } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { applyMigrations } from "../src/db/migrate.js";
import { Repo } from "../src/db/repo.js";
import type { DatabaseSyncLike } from "../src/db/types.js";

let db: DatabaseSyncLike;
let repo: Repo;

beforeEach(() => {
  db = openDatabase(":memory:");
  applyMigrations(db);
  repo = new Repo(db);
});

describe("migrations", () => {
  it("are idempotent - applying twice does not error", () => {
    expect(() => applyMigrations(db)).not.toThrow();
  });
});

describe("Repo run mode", () => {
  it("defaults to the provided fallback when unset", () => {
    expect(repo.getRunMode("DRY_RUN")).toBe("DRY_RUN");
  });

  it("persists an updated run mode", () => {
    repo.setRunMode("PAPER");
    expect(repo.getRunMode("DRY_RUN")).toBe("PAPER");
    repo.setRunMode("LIVE");
    expect(repo.getRunMode("DRY_RUN")).toBe("LIVE");
  });
});

describe("Repo trades", () => {
  it("round-trips an open trade and reports it via getOpenTrade", () => {
    repo.insertTrade({
      id: "t1",
      runMode: "PAPER",
      openedAt: 100,
      targetPosition: "long",
      btcCapitalAtOpen: 3,
      riskFractionOfCapital: 0.015,
      stopLossRatio: 9.5,
      firstTargetRatio: 11,
      status: "open",
      trancheExecutionPlanIds: [],
    });
    const open = repo.getOpenTrade();
    expect(open?.id).toBe("t1");
    expect(open?.status).toBe("open");
  });

  it("closes a trade and it no longer shows as open", () => {
    repo.insertTrade({
      id: "t2",
      runMode: "PAPER",
      openedAt: 100,
      targetPosition: "long",
      btcCapitalAtOpen: 3,
      riskFractionOfCapital: 0.015,
      stopLossRatio: 9.5,
      firstTargetRatio: 11,
      status: "open",
      trancheExecutionPlanIds: [],
    });
    repo.closeTrade("t2", "closed_win", 0.02);
    expect(repo.getOpenTrade()).toBeUndefined();
  });

  it("tracks the last stop-out timestamp for the cooldown gate", () => {
    repo.insertTrade({
      id: "t3",
      runMode: "PAPER",
      openedAt: 100,
      targetPosition: "long",
      btcCapitalAtOpen: 3,
      riskFractionOfCapital: 0.015,
      stopLossRatio: 9.5,
      firstTargetRatio: 11,
      status: "open",
      trancheExecutionPlanIds: [],
    });
    expect(repo.getLastStopOutAt()).toBeUndefined();
    repo.closeTrade("t3", "closed_loss", -0.03);
    expect(repo.getLastStopOutAt()).toBeTypeOf("number");
  });
});

describe("Repo nav points", () => {
  it("round-trips a NAV point in BTC-denominated terms", () => {
    repo.insertNavPoint({
      timestamp: 500,
      btcHeld: 3,
      xautHeld: 0,
      btcXautRatio: 12.5,
      btcEquivalentNav: 3,
    });
    const latest = repo.getLatestNavPoint();
    expect(latest?.btcEquivalentNav).toBe(3);
    expect(latest?.btcHeld).toBe(3);
  });

  it("returns NAV history in ascending timestamp order", () => {
    repo.insertNavPoint({ timestamp: 300, btcHeld: 1, xautHeld: 0, btcXautRatio: 10, btcEquivalentNav: 1 });
    repo.insertNavPoint({ timestamp: 100, btcHeld: 2, xautHeld: 0, btcXautRatio: 10, btcEquivalentNav: 2 });
    repo.insertNavPoint({ timestamp: 200, btcHeld: 3, xautHeld: 0, btcXautRatio: 10, btcEquivalentNav: 3 });
    const history = repo.getNavHistory();
    expect(history.map((p) => p.timestamp)).toEqual([100, 200, 300]);
  });
});
