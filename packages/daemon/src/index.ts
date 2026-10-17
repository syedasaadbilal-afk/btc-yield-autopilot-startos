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
import { BACKFILL_NAME, backfillExecutionFills } from "./backfill.js";

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

  // One-time-per-startup backfill for trades opened before migration 006
  // (task #86) - see repo.ts's docstring. Idempotent (only touches rows
  // still missing entry_price), so safe to run unconditionally every boot.
  repo.backfillMissingEntryPrices();
  const existingMode = repo.getRunMode(INITIAL_RUN_MODE);
  repo.setRunMode(existingMode); // ensures the singleton row exists

  const pairSummary = DEFAULT_STRATEGY_CONFIG.pairs
    .map((p) => `${p.key}(${p.ratioSymbol}, ${(p.capitalFractionBtc * 100).toFixed(0)}%)`)
    .join(", ");
  console.log(`[autopilot] starting, pairs=[${pairSummary}] runMode=${existingMode} tickMs=${TICK_MS}`);

  const state: ServerState = { lastTickAt: null, lastResults: [], tickMs: TICK_MS };
  // Guards against overlapping tick() executions - without this, the
  // automatic startup tick (below) and a manual "Run decision now" click
  // (or the setInterval tick firing while a slow candle-fetch/order-placement
  // tick is still in flight) can run concurrently. Both would read the same
  // stale allocation_state row before either's write commits, defeating the
  // per-pair fractionChanged idempotency check in loop.ts and executing the
  // same entry/resize twice - observed in practice as a pair's NAV getting
  // funded twice over.
  let tickInProgress = false;

  const tick = async () => {
    if (tickInProgress) {
      console.log("[autopilot] tick already in progress, skipping overlapping run");
      return;
    }
    tickInProgress = true;
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
    } finally {
      tickInProgress = false;
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

  // One-time: reconstruct order summaries + real fill prices for executions
  // logged before v0.1.7 from Bitfinex order history (read-only). Marked done
  // only on success, so a network failure retries on the next boot.
  if (!repo.isBackfillDone(BACKFILL_NAME)) {
    try {
      const secrets = readBitfinexSecrets(DB_PATH);
      const client = new BitfinexRestClient({
        apiKey: secrets.apiKey,
        apiSecret: secrets.apiSecret,
        baseUrl: process.env.BFX_BASE_URL ?? "https://api.bitfinex.com",
        runMode: repo.getRunMode(INITIAL_RUN_MODE),
      });
      // Bounded so a hung request can never hold up the first tick.
      const r = await Promise.race([
        backfillExecutionFills({ client, repo, config: DEFAULT_STRATEGY_CONFIG }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("backfill timed out after 120s")), 120_000)),
      ]);
      repo.markBackfillDone(BACKFILL_NAME);
      console.log(`[autopilot] backfill done: ${r.executionsUpdated} executions, ${r.tradesUpdated} trades updated.`);
    } catch (err) {
      console.warn("[autopilot] backfill skipped (will retry next start):", err instanceof Error ? err.message : err);
    }
  }

  await tick();
  setInterval(tick, TICK_MS);

  // Extra decision tick just after each UTC daily-bar close (00:02), so a
  // TradingView next-bar-open signal is acted on within minutes instead of
  // waiting for the next 4-hourly tick. Overlap with the regular interval is
  // harmless: tickInProgress serialises runs and decisions are idempotent.
  const scheduleMidnightTick = () => {
    const now = new Date();
    const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 2, 0);
    const at = next > now.getTime() + 1000 ? next : next + 24 * 3_600_000;
    setTimeout(() => {
      console.log("[autopilot] UTC daily-close tick");
      void tick().finally(scheduleMidnightTick);
    }, at - now.getTime());
  };
  scheduleMidnightTick();
}

main().catch((err) => {
  console.error("[autopilot] fatal:", err);
  process.exit(1);
});
