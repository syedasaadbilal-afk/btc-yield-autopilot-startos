import fs from "node:fs";
import { DEFAULT_STRATEGY_CONFIG } from "@autopilot/shared";
import { replayLarssonRotation, toLarssonInputCandles } from "@autopilot/strategy";

async function main() {
  const pair = DEFAULT_STRATEGY_CONFIG.pairs.find((p) => p.key === "xaut")!;

  // Fetched via web_fetch (sandbox bash has no direct network egress to
  // Bitfinex) from the exact same endpoint restClient.ts's getCandles() uses:
  // https://api-pub.bitfinex.com/v2/candles/trade:1D:tXAUT:BTC/hist?limit=400
  const rows = JSON.parse(fs.readFileSync("./xaut_candles.json", "utf-8")) as number[][];
  const raw = rows
    .map((r) => ({ timestamp: r[0]!, open: r[1]!, close: r[2]!, high: r[3]!, low: r[4]!, volume: r[5]! }))
    .sort((a, b) => a.timestamp - b.timestamp);
  console.log(`loaded ${raw.length} candles, last=${new Date(raw[raw.length - 1]!.timestamp).toISOString()}`);

  const input = toLarssonInputCandles(raw, pair);
  const history = replayLarssonRotation(input, DEFAULT_STRATEGY_CONFIG.larsson, "long");

  console.log("\n--- switches in last 120 days ---");
  const cutoff = Date.now() - 120 * 24 * 60 * 60 * 1000;
  for (const day of history) {
    if (day.timestamp < cutoff) continue;
    if (day.switched) {
      console.log(
        `${new Date(day.timestamp).toISOString().slice(0, 10)}  SWITCH -> ${day.position}  regime=${day.regime}  reason="${day.reason}"`
      );
    }
  }

  console.log("\n--- last 10 days (regime/position) ---");
  for (const day of history.slice(-10)) {
    console.log(
      `${new Date(day.timestamp).toISOString().slice(0, 10)}  regime=${day.regime}  position=${day.position}  distFromBaseline=${day.distFromBaseline.toFixed(4)}  switched=${day.switched}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
