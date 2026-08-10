import { describe, expect, it } from "vitest";
import { DEFAULT_LARSSON_CONFIG, replayLarssonRotation } from "../src/larssonRotation.js";
import { makeCandles, linearRamp } from "./testUtils.js";

describe("replayLarssonRotation", () => {
  it("stays long (navy/flat baseline) when price never trends away from it", () => {
    const closes = new Array(100).fill(100);
    const result = replayLarssonRotation(makeCandles(closes), DEFAULT_LARSSON_CONFIG);
    const last = result[result.length - 1]!;
    expect(last.position).toBe("long");
    expect(last.regime).toBe("navy");
    expect(result.some((r) => r.switched)).toBe(false);
  });

  it("enters the rotation asset on a mild, gradual move into orange within the entry-distance band", () => {
    const closes = [...new Array(60).fill(100), ...linearRamp(100, 102, 40)];
    const result = replayLarssonRotation(makeCandles(closes), DEFAULT_LARSSON_CONFIG);
    const entryIndex = result.findIndex((r) => r.switched && r.position === "flat");

    expect(entryIndex).toBeGreaterThan(-1);
    expect(result[entryIndex]!.regime).toBe("orange");
    expect(result[entryIndex]!.distFromBaseline).toBeLessThanOrEqual(DEFAULT_LARSSON_CONFIG.entryMaxDistFraction);
    expect(result[entryIndex]!.reason).toMatch(/rotating btc -> asset/i);
  });

  it("does not chase an already-extended move - no entry if orange only appears past the max entry distance", () => {
    const closes = [...new Array(60).fill(100), ...linearRamp(100, 160, 5)]; // sharp, fast jump
    const result = replayLarssonRotation(makeCandles(closes), DEFAULT_LARSSON_CONFIG);

    const firstOrange = result.find((r) => r.regime === "orange");
    expect(firstOrange).toBeDefined();
    expect(firstOrange!.distFromBaseline).toBeGreaterThan(DEFAULT_LARSSON_CONFIG.entryMaxDistFraction);
    expect(result.some((r) => r.switched)).toBe(false);
    expect(result[result.length - 1]!.position).toBe("long");
  });

  it("exits on the overextension take-profit when price keeps extending well above baseline", () => {
    const closes = [
      ...new Array(60).fill(100),
      ...linearRamp(100, 102, 40), // clean entry within the entry band
      ...linearRamp(102, 150, 80), // keeps climbing, well past the overextension target
    ];
    const result = replayLarssonRotation(makeCandles(closes), DEFAULT_LARSSON_CONFIG);
    const entryIndex = result.findIndex((r) => r.switched && r.position === "flat");
    expect(entryIndex).toBeGreaterThan(-1);

    const exitIndex = result.findIndex((r, i) => i > entryIndex && r.switched);
    expect(exitIndex).toBeGreaterThan(-1);
    expect(result[exitIndex]!.position).toBe("long");
    expect(result[exitIndex]!.distFromBaseline).toBeGreaterThanOrEqual(
      DEFAULT_LARSSON_CONFIG.overextensionFraction
    );
    expect(result[exitIndex]!.reason).toMatch(/overextend/i);
  });

  it("exits on regime reversal when price falls back through the baseline after entry", () => {
    const closes = [
      ...new Array(60).fill(100),
      ...linearRamp(100, 102, 40), // clean entry
      ...linearRamp(102, 90, 30), // reverses hard, well below baseline
    ];
    const result = replayLarssonRotation(makeCandles(closes), DEFAULT_LARSSON_CONFIG);
    const entryIndex = result.findIndex((r) => r.switched && r.position === "flat");
    expect(entryIndex).toBeGreaterThan(-1);

    const exitIndex = result.findIndex((r, i) => i > entryIndex && r.switched);
    expect(exitIndex).toBeGreaterThan(-1);
    expect(result[exitIndex]!.position).toBe("long");
    expect(["navy", "gray"]).toContain(result[exitIndex]!.regime);
    expect(result[exitIndex]!.reason).toMatch(/reversal/i);
  });

  it("is deterministic given identical input", () => {
    const closes = [...new Array(60).fill(100), ...linearRamp(100, 102, 40), ...linearRamp(102, 150, 80)];
    const a = replayLarssonRotation(makeCandles(closes), DEFAULT_LARSSON_CONFIG);
    const b = replayLarssonRotation(makeCandles(closes), DEFAULT_LARSSON_CONFIG);
    expect(a).toEqual(b);
  });
});
