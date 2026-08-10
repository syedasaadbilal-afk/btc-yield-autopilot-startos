import { describe, expect, it } from "vitest";
import { DEFAULT_ROTATION_CONFIG, replayRotation } from "../src/rotation.js";
import { makeCandles } from "./testUtils.js";

/**
 * Builds a noisy drifting price path. Pure step-function/flat data (no
 * up-days at all) pins Wilder's RSI at an extreme for the whole move, which
 * never happens on real market data - there's always some chop. `amplitude`
 * must exceed `drift` per step for genuine up-days to occur, which is what
 * keeps RSI in a normal (non-pinned) range during a sustained decline or
 * rally, matching how the reference Pine Script actually behaves live.
 */
function noisyPath(start: number, steps: number, driftPerStep: number, amplitude: number): number[] {
  const out: number[] = [];
  let v = start;
  for (let i = 0; i < steps; i++) {
    v += driftPerStep + (i % 2 === 0 ? amplitude : -amplitude);
    out.push(Math.round(v * 10000) / 10000);
  }
  return out;
}

describe("replayRotation", () => {
  it("stays long the whole time when r never breaches the entry band", () => {
    const closes = new Array(260).fill(20);
    const result = replayRotation(makeCandles(closes), DEFAULT_ROTATION_CONFIG);
    expect(result[result.length - 1]!.position).toBe("long");
    expect(result.some((r) => r.switched)).toBe(false);
  });

  it("rotates to XAUT when r drops below the SMA entry band, and back on trend recovery", () => {
    const decline = noisyPath(20, 90, -0.03, 0.2); // noisy decline, real up-days mixed in
    const closes = [...new Array(250).fill(20), ...decline, 25]; // sharp bounce, well past the exit-confirm band
    const result = replayRotation(makeCandles(closes), DEFAULT_ROTATION_CONFIG);

    expect(result.some((r) => r.position === "flat")).toBe(true);

    const last = result[result.length - 1]!;
    expect(last.position).toBe("long");
    expect(last.switched).toBe(true);
    expect(last.reason).toMatch(/trend recovery/i);
  });

  it("enforces the long->flat cooldown - does not re-enter flat within cooldownDays of the last switch", () => {
    const decline = noisyPath(20, 40, -0.05, 0.2); // enters flat partway through
    const closes = [
      ...new Array(250).fill(20),
      ...decline,
      25, // trend-recovery exit back to long (switch)
      ...new Array(5).fill(14), // dips again immediately - should NOT re-enter, cooldown not elapsed
    ];
    const result = replayRotation(makeCandles(closes), DEFAULT_ROTATION_CONFIG);
    const tail = result.slice(-5);
    expect(tail.every((r) => r.position === "long")).toBe(true);
    expect(tail.every((r) => !r.switched)).toBe(true);
  });

  it("anti-whipsaw: does not exit flat on a same-week bounce, even if it clears the SMA", () => {
    // Sideways/choppy scenario: dip triggers entry, then an immediate sharp
    // bounce clears the SMA a few days later. Without minFlatHoldDays this
    // flips straight back to BTC; with it, the flat leg must be held first.
    const decline = noisyPath(20, 60, -0.03, 0.2);
    const preEntry = [...new Array(250).fill(20), ...decline];
    const entryState = replayRotation(makeCandles(preEntry), DEFAULT_ROTATION_CONFIG);
    const entryIndex = entryState.findIndex((r) => r.switched && r.position === "flat");
    expect(entryIndex).toBeGreaterThan(-1);
    const baseCloses = preEntry.slice(0, entryIndex + 1); // trim to the entry day itself

    const bounceCloses = [...baseCloses, 25, 25, 25]; // bounce 3 days after entry - inside the 10d hold
    const bounced = replayRotation(makeCandles(bounceCloses), DEFAULT_ROTATION_CONFIG);
    const last = bounced[bounced.length - 1]!;
    expect(last.position).toBe("flat");
    expect(last.switched).toBe(false);
    expect(last.reason).toMatch(/minimum hold/i);
  });

  it("exits on the momentum take-profit path when r gains from entry without crossing back above the SMA", () => {
    // The default momentumTakeProfitFraction (20%) sits far outside the
    // exitConfirmBandFraction (2%) gap that typically exists between entry
    // price and SMA at the moment of entry, so in practice the trend-recovery
    // path almost always fires first (see conversation notes on this). To
    // exercise the momentum branch itself in isolation, use a tighter
    // momentum threshold than production default - this proves the branch's
    // logic/priority (momentum fires, and is reported as such, whenever it is
    // the first threshold crossed) independent of that parameter interaction.
    const config = { ...DEFAULT_ROTATION_CONFIG, momentumTakeProfitFraction: 0.03 };
    const decline = noisyPath(20, 60, -0.03, 0.2);
    const preEntry = [...new Array(250).fill(20), ...decline];
    const entryState = replayRotation(makeCandles(preEntry), config);
    const entryIndex = entryState.findIndex((r) => r.switched && r.position === "flat");
    expect(entryIndex).toBeGreaterThan(-1);
    const entryR = entryState[entryIndex]!.r;
    const baseCloses = preEntry.slice(0, entryIndex + 1);

    const holdFiller = new Array(config.minFlatHoldDays).fill(entryR);
    const target = entryR * 1.05; // >3% momentum threshold, but still under the SMA's exit-confirm band
    const closes = [...baseCloses, ...holdFiller, target];
    const result = replayRotation(makeCandles(closes), config);
    const last = result[result.length - 1]!;

    expect(last.r).toBeLessThanOrEqual(last.sma * (1 + config.exitConfirmBandFraction));
    expect(last.position).toBe("long");
    expect(last.switched).toBe(true);
    expect(last.reason).toMatch(/momentum/i);
  });

  it("exits on RSI capitulation when the decline accelerates further (not a trend recovery or momentum gain)", () => {
    const decline = noisyPath(20, 60, -0.03, 0.2);
    const preEntry = [...new Array(250).fill(20), ...decline];
    const entryState = replayRotation(makeCandles(preEntry), DEFAULT_ROTATION_CONFIG);
    const entryIndex = entryState.findIndex((r) => r.switched && r.position === "flat");
    expect(entryIndex).toBeGreaterThan(-1);
    const entryR = entryState[entryIndex]!.r;
    const baseCloses = preEntry.slice(0, entryIndex + 1);

    // Past the hold period, an accelerating crash (all down-days) pushes RSI
    // deeply oversold without gaining on entry or crossing back above SMA.
    const crash: number[] = [];
    let v = entryR;
    for (let i = 0; i < 60; i++) {
      v *= 0.96;
      crash.push(Math.round(v * 10000) / 10000);
    }
    const closes = [...baseCloses, ...crash];
    const result = replayRotation(makeCandles(closes), DEFAULT_ROTATION_CONFIG);

    const capIndex = result.findIndex(
      (r, i) => i > entryIndex && r.switched && /capitulation/i.test(r.reason)
    );
    expect(capIndex).toBeGreaterThan(-1);
    expect(result[capIndex]!.position).toBe("long");
    expect(result[capIndex]!.r).toBeLessThan(result[capIndex]!.sma);
  });

  it("is deterministic given identical input", () => {
    const closes = [...new Array(260).fill(20), 14, 25];
    const a = replayRotation(makeCandles(closes), DEFAULT_ROTATION_CONFIG);
    const b = replayRotation(makeCandles(closes), DEFAULT_ROTATION_CONFIG);
    expect(a).toEqual(b);
  });
});
