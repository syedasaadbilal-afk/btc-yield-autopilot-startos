import { describe, expect, it, vi } from "vitest";
import { BitfinexRestClient } from "../src/restClient.js";

function jsonResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as Response;
}

describe("BitfinexRestClient", () => {
  it("never calls fetch when submitting an order in DRY_RUN mode", async () => {
    const fetchMock = vi.fn();
    const client = new BitfinexRestClient(
      { apiKey: "k", apiSecret: "s", baseUrl: "https://example.invalid", runMode: "DRY_RUN" },
      fetchMock as unknown as typeof fetch
    );
    const result = await client.submitOrder({
      symbol: "tBTC:XAUT",
      amount: 0.01,
      price: "10",
      type: "EXCHANGE LIMIT",
    });
    expect(result.dryRun).toBe(true);
    expect(result.submitted).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls fetch when submitting in PAPER mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "abc" }));
    const client = new BitfinexRestClient(
      { apiKey: "k", apiSecret: "s", baseUrl: "https://example.invalid", runMode: "PAPER" },
      fetchMock as unknown as typeof fetch
    );
    const result = await client.submitOrder({
      symbol: "tBTC:XAUT",
      amount: 0.01,
      price: "10",
      type: "EXCHANGE LIMIT",
    });
    expect(result.submitted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("parses candle rows into ascending-order Candle objects", async () => {
    const rows = [
      [3000, 10, 12, 13, 9, 100],
      [1000, 8, 10, 11, 7, 50],
      [2000, 10, 11, 12, 9, 75],
    ];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(rows));
    const client = new BitfinexRestClient(
      { apiKey: "k", apiSecret: "s", baseUrl: "https://example.invalid", runMode: "DRY_RUN" },
      fetchMock as unknown as typeof fetch
    );
    const candles = await client.getCandles("tBTC:XAUT", "1D", 3);
    expect(candles.map((c) => c.timestamp)).toEqual([1000, 2000, 3000]);
    expect(candles[0]).toMatchObject({ open: 8, close: 10, high: 11, low: 7, volume: 50 });
  });

  it("splits book rows into bid/ask depth by amount sign", async () => {
    const rows = [
      [100, 1, 2.5], // bid
      [101, 1, -1.5], // ask
      [99, 1, 1.0], // bid
    ];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(rows));
    const client = new BitfinexRestClient(
      { apiKey: "k", apiSecret: "s", baseUrl: "https://example.invalid", runMode: "DRY_RUN" },
      fetchMock as unknown as typeof fetch
    );
    const depth = await client.getBookDepth("tBTC:XAUT");
    expect(depth.bidDepth).toBeCloseTo(3.5, 6);
    expect(depth.askDepth).toBeCloseTo(1.5, 6);
  });
});
