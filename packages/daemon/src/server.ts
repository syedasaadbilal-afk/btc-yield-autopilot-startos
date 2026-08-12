import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import { DEFAULT_STRATEGY_CONFIG, RUN_MODES, type RunMode } from "@autopilot/shared";
import type { Repo } from "./db/repo.js";
import type { PairLoopResult } from "./loop.js";
import { hasBitfinexSecrets, writeBitfinexSecrets, readBitfinexSecrets } from "./secrets.js";
import { BitfinexRestClient } from "@autopilot/bitfinex-client";

/**
 * In-memory snapshot of the most recent tick, updated by index.ts after every
 * runControlLoopIteration() call. Not persisted - on daemon restart this is
 * just empty until the first tick completes, at which point /api/status
 * falls back to DB-derived state (open trade, latest decision) below.
 */
export interface ServerState {
  lastTickAt: number | null;
  lastResults: PairLoopResult[];
  tickMs: number;
}

export interface CreateServerOptions {
  repo: Repo;
  state: ServerState;
  runNow: () => Promise<void>;
  port: number;
  /** Directory containing the built dashboard's static assets (index.html, JS, CSS). Skipped if it doesn't exist - API still works standalone. */
  staticDir?: string;
  /** SQLite DB path - secrets.ts colocates bfx-secrets.json next to it inside the mounted data volume. */
  dbPath: string;
}

// Real live Bitfinex wallet balances for /api/status - cached briefly to
// avoid hammering the exchange API on every dashboard poll. Separate from
// the internal NAV/allocation ledger, which can drift from the real wallet
// (see the Aug 2026 dashboard staleness bug) - this is ground truth read
// straight from the exchange.
let walletCache: { at: number; balances: Record<string, number> } | null = null;
const WALLET_CACHE_MS = 15_000;
const PAIR_WALLET_CURRENCY: Record<string, string> = { xaut: "XAUT", xmr: "XMR" };

export async function createServer(opts: CreateServerOptions) {
  async function getLiveWalletBalances(): Promise<Record<string, number>> {
    if (walletCache && Date.now() - walletCache.at < WALLET_CACHE_MS) return walletCache.balances;
    if (!hasBitfinexSecrets(opts.dbPath)) return {};
    try {
      const secrets = readBitfinexSecrets(opts.dbPath);
      const client = new BitfinexRestClient({
        apiKey: secrets.apiKey,
        apiSecret: secrets.apiSecret,
        baseUrl: process.env.BFX_BASE_URL ?? "https://api.bitfinex.com",
        runMode: opts.repo.getRunMode(),
      });
      const wallets = await client.getWallets();
      const balances: Record<string, number> = {};
      for (const w of wallets) balances[w.currency.toUpperCase()] = w.balance;
      walletCache = { at: Date.now(), balances };
      return balances;
    } catch (err) {
      console.error("[autopilot] failed to fetch live wallet balances:", err);
      return walletCache?.balances ?? {};
    }
  }
  const fastify = Fastify({ logger: false });

  const hasStatic = opts.staticDir && fs.existsSync(opts.staticDir);
  if (hasStatic && opts.staticDir) {
    await fastify.register(fastifyStatic, {
      root: opts.staticDir,
    });
    fastify.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith("/api/")) {
        reply.code(404).send({ error: "not found" });
        return;
      }
      reply.sendFile("index.html");
    });
  } else {
    console.warn(`[autopilot] dashboard static dir not found (${opts.staticDir ?? "unset"}) - serving API only`);
  }

  fastify.get("/api/status", async () => {
    const runMode = opts.repo.getRunMode();
    const liveBalances = await getLiveWalletBalances();
    const pairs = DEFAULT_STRATEGY_CONFIG.pairs.map((pair) => {
      const openTrade = opts.repo.getOpenTrade(pair.key);
      const latestDecision = opts.repo.getLatestLarssonDecision(pair.key);
      const latestNav = opts.repo.getLatestNavPoint(pair.key);
      const lastResult = opts.state.lastResults.find((r) => r.pairKey === pair.key);
      // Dynamic, not the static PairConfig default: this is the fraction
      // computePortfolioAllocation actually applied - falls back through the
      // last tick's result, then the DB's last-applied allocation_state row
      // (survives a daemon restart), then finally the static config value
      // before this pair has ever ticked at all.
      const targetFractionBtc =
        lastResult?.targetFraction ?? opts.repo.getAllocationFraction(pair.key) ?? pair.capitalFractionBtc;
      return {
        pairKey: pair.key,
        displayName: pair.displayName,
        capitalFractionBtc: targetFractionBtc,
        currentPosition: lastResult?.currentPosition ?? (openTrade ? "long" : "flat"),
        decisionTarget: lastResult?.decisionTarget ?? latestDecision?.position ?? "flat",
        gateAllowed: lastResult?.gateAllowed ?? true,
        gateReason: lastResult?.gateReason ?? "No tick yet.",
        rotated: lastResult?.rotated ?? false,
        error: lastResult?.error ?? null,
        regime: latestDecision?.regime ?? null,
        reason: latestDecision?.reason ?? null,
        distFromBaseline: latestDecision?.distFromBaseline ?? null,
        btcEquivalentNav: latestNav?.btcEquivalentNav ?? null,
        openTrade: openTrade ?? null,
        realAssetHeld: liveBalances[PAIR_WALLET_CURRENCY[pair.key] ?? ""] ?? null,
      };
    });
    return {
      runMode,
      tickMs: opts.state.tickMs,
      lastTickAt: opts.state.lastTickAt,
      nextTickAt: opts.state.lastTickAt ? opts.state.lastTickAt + opts.state.tickMs : null,
      startingBtc: DEFAULT_STRATEGY_CONFIG.capital.startingBtc,
      realBtcHeld: liveBalances["BTC"] ?? null,
      pairs,
    };
  });

  fastify.get("/api/history", async (req) => {
    const q = req.query as { pairKey?: string; limit?: string };
    const pairKey = q.pairKey ?? DEFAULT_STRATEGY_CONFIG.pairs[0]!.key;
    const limit = Math.min(Number(q.limit ?? 50) || 50, 200);
    return opts.repo.getRecentLarssonDecisions(pairKey, limit);
  });

  fastify.get("/api/nav", async (req) => {
    const q = req.query as { pairKey?: string };
    const pairKey = q.pairKey ?? DEFAULT_STRATEGY_CONFIG.pairs[0]!.key;
    return opts.repo.getNavHistory(pairKey);
  });

  fastify.get("/api/trades", async (req) => {
    const q = req.query as { pairKey?: string; limit?: string };
    const pairKey = q.pairKey ?? DEFAULT_STRATEGY_CONFIG.pairs[0]!.key;
    const limit = Math.min(Number(q.limit ?? 100) || 100, 500);
    return opts.repo.getRecentTrades(pairKey, limit);
  });
  // Read-only diagnostic snapshot of internal position-tracking state per
  // pair - added Aug 2026 after a stuck-open-trade bug (a bootstrap-inferred
  // trade left "open" by pre-fix code) took over an hour to diagnose via
  // SSH/container/volume archaeology, because nothing exposed openTrade /
  // hasLiveTrade / dbDerivedPosition anywhere queryable. This exposes
  // exactly the inputs that drive loop.ts's currentPosition computation so
  // future issues can be diagnosed with one HTTP call instead of hunting for
  // the live DB file across container mount namespaces.
  fastify.get("/api/debug/state", async () => {
    const runMode = opts.repo.getRunMode();
    const pairs = DEFAULT_STRATEGY_CONFIG.pairs.map((pair) => {
      const openTrade = opts.repo.getOpenTrade(pair.key);
      const hasLiveTrade = opts.repo.hasLiveTrade(pair.key);
      const latestNav = opts.repo.getLatestNavPoint(pair.key);
      const isFirstTickForPair = latestNav === undefined;
      const needsLiveBootstrapCheck = runMode === "LIVE" && !hasLiveTrade;
      const dbDerivedPosition = openTrade ? "long" : "flat";
      const latestDecision = opts.repo.getLatestLarssonDecision(pair.key);
      return {
        pairKey: pair.key,
        openTrade: openTrade ?? null,
        hasLiveTrade,
        isFirstTickForPair,
        needsBootstrapCheck: isFirstTickForPair || needsLiveBootstrapCheck,
        dbDerivedPosition,
        latestNavAt: latestNav?.timestamp ?? null,
        latestDecision: latestDecision ?? null,
        recentTrades: opts.repo.getRecentTrades(pair.key, 5),
      };
    });
    return { runMode, generatedAt: Date.now(), pairs };
  });

  // Read-only strategy config snapshot for the dashboard's Config tab (design
  // doc: "no rebuild to tune" - this is what's ACTUALLY running, not just
  // whatever the dashboard bundle happened to be built against).
  fastify.get("/api/config", async () => {
    const { regime, confluence, contrarian, rotation, ...active } = DEFAULT_STRATEGY_CONFIG;
    return active;
  });

  // Bitfinex API credentials - file-based (see secrets.ts), never baked into
  // the image or committed anywhere. GET only ever reports whether they're
  // set, never the values themselves - this is a trading-capable secret.
  fastify.get("/api/secrets/bitfinex", async () => ({ configured: hasBitfinexSecrets(opts.dbPath) }));

  fastify.put("/api/secrets/bitfinex", async (req, reply) => {
    const body = req.body as { apiKey?: string; apiSecret?: string } | undefined;
    // Trim before validating and storing - a trailing newline or leading/trailing
    // space from copy-paste is invisible in the input field but breaks the
    // HMAC signature on every request, surfacing as Bitfinex's opaque
    // "apikey: digest invalid" error with no indication the secret itself
    // is the problem.
    const apiKey = body?.apiKey?.trim();
    const apiSecret = body?.apiSecret?.trim();
    if (!apiKey || !apiSecret) {
      reply.code(400);
      return { error: "apiKey and apiSecret are both required" };
    }
    writeBitfinexSecrets(opts.dbPath, { apiKey, apiSecret });
    console.log("[autopilot] Bitfinex API credentials updated via dashboard - restart the daemon to pick them up.");
    return { configured: true, note: "Restart the daemon for the new credentials to take effect." };
  });

  fastify.get("/api/run-mode", async () => ({ mode: opts.repo.getRunMode() }));

  fastify.put("/api/run-mode", async (req, reply) => {
    const body = req.body as { mode?: string } | undefined;
    const mode = body?.mode;
    if (!mode || !(RUN_MODES as readonly string[]).includes(mode)) {
      reply.code(400);
      return { error: `mode must be one of ${RUN_MODES.join(", ")}` };
    }
    opts.repo.setRunMode(mode as RunMode);
    console.log(`[autopilot] run mode changed via dashboard -> ${mode}`);
    return { mode };
  });

  // "Run decision now" - matches the button pattern from Hashrate Autopilot's
  // dashboard. Fires the same tick() the interval timer uses; responds
  // immediately since a tick can take a while (candle fetches, order
  // placement) rather than making the request hang.
  fastify.post("/api/run-now", async () => {
    opts.runNow().catch((err) => console.error("[autopilot] manual run failed:", err));
    return { started: true };
  });

  await fastify.listen({ port: opts.port, host: "0.0.0.0" });
  console.log(`[autopilot] dashboard/API listening on :${opts.port}`);
  return fastify;
}
