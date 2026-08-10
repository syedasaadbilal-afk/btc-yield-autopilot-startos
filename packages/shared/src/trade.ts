import type { RunMode } from "./runMode.js";
import type { PositionState } from "./position.js";

export interface Trade {
  id: string;
  runMode: RunMode;
  /** Which rotation instance opened this trade (PairConfig.key). Absent = legacy "xaut". */
  pairKey?: string;
  openedAt: number;
  closedAt?: number;
  /** Position entered into, e.g. "long" means this trade rotated XAUT -> BTC. */
  targetPosition: PositionState;
  /** BTC amount at open, used as the base for the BTC-denominated risk rule. */
  btcCapitalAtOpen: number;
  riskFractionOfCapital: number;
  stopLossRatio: number;
  /** First-target take-profit ratio; must be >= 2x the risk distance (2:1 R:R minimum). */
  firstTargetRatio: number;
  status: "open" | "closed_win" | "closed_loss" | "cancelled";
  /** Net BTC change once fully closed and (if flat) rotated back to BTC-equivalent. */
  realizedBtcPnl?: number;
  trancheExecutionPlanIds: string[];
  notes?: string;
}
