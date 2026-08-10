import type { NavPoint, RunMode, StrategyConfig, Trade } from "@autopilot/shared";

/** What GET /api/config returns - the active strategy config minus the legacy (unused) sections. */
export type ActiveStrategyConfig = Omit<StrategyConfig, "regime" | "confluence" | "contrarian" | "rotation">;

export interface PairStatus {
  pairKey: string;
  displayName: string;
  /**
   * This pair's actual applied share of total portfolio capital. Dynamic,
   * not a fixed config value: computed each tick by comparing both pairs'
   * regimes (see @autopilot/strategy's computePortfolioAllocation) - gold
   * (orange) + blue (navy/gray) -> 100/0, gold + gold -> 50/50, blue + blue
   * -> 0/0 (100% effectively sits in BTC).
   */
  capitalFractionBtc: number;
  currentPosition: "flat" | "long";
  decisionTarget: "flat" | "long";
  gateAllowed: boolean;
  gateReason: string;
  rotated: boolean;
  error: string | null;
  regime: "gray" | "orange" | "navy" | null;
  reason: string | null;
  distFromBaseline: number | null;
  btcEquivalentNav: number | null;
  openTrade: unknown | null;
}

export interface StatusResponse {
  runMode: RunMode;
  tickMs: number;
  lastTickAt: number | null;
  nextTickAt: number | null;
  startingBtc: number;
  pairs: PairStatus[];
}

export interface DecisionRow {
  timestamp: number;
  r: number;
  v1: number;
  m1: number;
  m2: number;
  v2: number;
  regime: "gray" | "orange" | "navy";
  distFromBaseline: number;
  position: "flat" | "long";
  switched: boolean;
  reason: string;
}

async function getJson<T>(url: string): Promise<T | undefined> {
  try {
    const res = await fetch(url);
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

export async function fetchStatus(): Promise<StatusResponse | undefined> {
  return getJson<StatusResponse>("/api/status");
}

export async function fetchHistory(pairKey: string, limit = 30): Promise<DecisionRow[]> {
  return (await getJson<DecisionRow[]>(`/api/history?pairKey=${pairKey}&limit=${limit}`)) ?? [];
}

export async function fetchNavHistory(pairKey: string): Promise<NavPoint[]> {
  return (await getJson<NavPoint[]>(`/api/nav?pairKey=${pairKey}`)) ?? [];
}

export async function fetchTrades(pairKey: string, limit = 100): Promise<Trade[]> {
  return (await getJson<Trade[]>(`/api/trades?pairKey=${pairKey}&limit=${limit}`)) ?? [];
}

export async function fetchConfig(): Promise<ActiveStrategyConfig | undefined> {
  return getJson<ActiveStrategyConfig>("/api/config");
}

export async function fetchBitfinexSecretsStatus(): Promise<{ configured: boolean }> {
  return (await getJson<{ configured: boolean }>("/api/secrets/bitfinex")) ?? { configured: false };
}

export async function saveBitfinexSecrets(apiKey: string, apiSecret: string): Promise<{ configured: boolean; note?: string } | undefined> {
  try {
    const res = await fetch("/api/secrets/bitfinex", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey, apiSecret }),
    });
    if (!res.ok) return undefined;
    return (await res.json()) as { configured: boolean; note?: string };
  } catch {
    return undefined;
  }
}

export async function setRunMode(mode: RunMode): Promise<void> {
  await fetch("/api/run-mode", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  }).catch(() => {
    // dashboard optimistically updates state regardless; next poll reconciles
  });
}

export async function runNow(): Promise<void> {
  await fetch("/api/run-now", { method: "POST" }).catch(() => {});
}
