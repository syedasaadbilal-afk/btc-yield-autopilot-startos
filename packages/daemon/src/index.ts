import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_STRATEGY_CONFIG, type RunMode } from "@autopilot/shared";
import { BitfinexRestClient } from "@autopilot/bitfinex-client";
import { openDatabase } from "./db/connection.js";
import { applyMigrations } from "./db/migrate.js";
import { Repo } from "./db/repo.js";
import { runControlLoopIteration, type PairLoopResult } from "./loop.js";
import { createServer, type ServerState } from "./server.js";
import { readBitfinexSecrets } from "./secrets.js";

const TICK_MS = Number(process.env.AUTOPILOT_TICK_MS ?? 4 * 60 * 60 * 1000); // 4h default, daily-signal strategy
const DB_PATH = process.env.AUTOPILOT_DB_PATH ?? "./autopilot.sqlite";
const INITIAL_RUN_MODE = (process.env.AUTOPILOT_RUN_MODE as RunMode | undefined) ?? "DRY_RUN";
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT ?? 8787);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Dockerfile copies the built dashboard (packages/dashboard/dist) to
// packages/daemon/public - see Dockerfile. Resolved relative to this file
// (not process.cwd()) so it works regardless of what directory node was
// started from.
const DASHBOARD_STATIC_DIR = process.env.DASHBOARD_STATIC_DIR ?? path.join(__dirname, "..", "public");

async function main() {
  const db = openDatabase(DB_PATH);
  applyMigrations(db);
  const repo = new Repo(db);

  if (!repo.getRunMode) throw new Error("Repo not wired correctly"); // defensive, cheap
  const existingMode = repo.getRunMode(INITIAL_RUN_MODE);
  repo.setRunMode(existingMode); // ensures the singleton row exists

  const pairSummary = DEFAULT_STRATEGY_CONFIG.pairs
    .map((p) => `${p.key}(${p.ratioSymbol}, ${(p.capitalFractionBtc * 100).toFixed(0)}%)`)
    .join(", ");
  console.log(`[autopilot] starting, pairs=[${pairSummary}] runMode=${existingMode} tickMs=${TICK_MS}`);

  const state: ServerState = { lastTickAt: null, lastResults: [], tickMs: TICK_MS };

  const tick = async () => {
    try {
      // Run mode is live-editable (design doc: "no rebuild to tune") - re-read
      // it every tick and rebuild the client so it reflects the current mode
      // (the client itself refuses to submit orders in DRY_RUN, see restClient.ts).
      const currentMode = repo.getRunMode(INITIAL_RUN_MODE);
      const secrets = readBitfinexSecrets(DB_PATH);
      const client = new BitfinexRestClient({
        apiKey: secrets.apiKey,
        apiSecret: secrets.apiSecret,
        baseUrl: process.env.BFX_BASE_URL ?? "https://api.bitfinex.com",
        runMode: currentMode,
      });
      const results: PairLoopResult[] = await runControlLoopIteration({
        client,
        repo,
        config: DEFAULT_STRATEGY_CONFIG,
      });
      for (const result of results) {
        console.log(`[autopilot][${result.pairKey}] tick result:`, result);
      }
      state.lastTickAt = Date.now();
      state.lastResults = results;
    } catch (err) {
      console.error("[autopilot] tick failed:", err);
    }
  };

  await createServer({
    repo,
    state,
    runNow: tick,
    port: DASHBOARD_PORT,
    staticDir: DASHBOARD_STATIC_DIR,
    dbPath: DB_PATH,
  });

  await tick();
  setInterval(tick, TICK_MS);
}

main().catch((err) => {
  console.error("[autopilot] fatal:", err);
  process.exit(1);
});
