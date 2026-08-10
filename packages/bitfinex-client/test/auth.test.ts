import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildAuthHeaders, MonotonicNonce } from "../src/auth.js";

describe("buildAuthHeaders", () => {
  it("matches an independently computed HMAC-SHA384 signature", () => {
    const params = {
      apiKey: "test-key",
      apiSecret: "test-secret",
      path: "v2/auth/w/order/submit",
      nonce: "123456789",
      body: '{"symbol":"tBTC:XAUT"}',
    };
    const headers = buildAuthHeaders(params);

    const expectedPayload = `/api/${params.path}${params.nonce}${params.body}`;
    const expectedSignature = createHmac("sha384", params.apiSecret)
      .update(expectedPayload)
      .digest("hex");

    expect(headers["bfx-signature"]).toBe(expectedSignature);
    expect(headers["bfx-apikey"]).toBe(params.apiKey);
    expect(headers["bfx-nonce"]).toBe(params.nonce);
  });

  it("produces a different signature for a different body", () => {
    const base = { apiKey: "k", apiSecret: "s", path: "v2/auth/w/order/submit", nonce: "1" };
    const a = buildAuthHeaders({ ...base, body: '{"amount":"1"}' });
    const b = buildAuthHeaders({ ...base, body: '{"amount":"2"}' });
    expect(a["bfx-signature"]).not.toBe(b["bfx-signature"]);
  });
});

describe("MonotonicNonce", () => {
  it("always increases, even when called repeatedly within the same millisecond", () => {
    const nonce = new MonotonicNonce();
    const values = Array.from({ length: 50 }, () => BigInt(nonce.next()));
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThan(values[i - 1]!);
    }
  });
});
