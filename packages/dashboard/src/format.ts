export type DisplayUnit = "btc" | "sats";

const SATS_PER_BTC = 100_000_000;

/** Formats a BTC-denominated amount in the user's chosen unit (mirrors Hashrate Autopilot's sats/BTC toggle). */
export function formatBtcAmount(btc: number, unit: DisplayUnit, opts?: { signed?: boolean }): string {
  const sign = opts?.signed ? (btc >= 0 ? "+" : "") : "";
  if (unit === "sats") {
    return `${sign}${Math.round(btc * SATS_PER_BTC).toLocaleString()} sat`;
  }
  return `${sign}${btc.toFixed(6)} BTC`;
}

export function formatPercent(fraction: number, opts?: { signed?: boolean }): string {
  const sign = opts?.signed !== false ? (fraction >= 0 ? "+" : "") : "";
  return `${sign}${(fraction * 100).toFixed(2)}%`;
}

export function formatTimeAgo(timestamp: number, now: number = Date.now()): string {
  const diffMs = now - timestamp;
  if (diffMs < 0) return "just now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatCountdown(ms: number): string {
  if (ms <= 0) return "any moment";
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}
