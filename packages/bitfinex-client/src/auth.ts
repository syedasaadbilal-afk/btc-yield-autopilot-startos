import { createHmac } from "node:crypto";

export interface BfxAuthHeaders {
  "bfx-nonce": string;
  "bfx-apikey": string;
  "bfx-signature": string;
}

/**
 * Bitfinex API v2 REST auth (design doc Section 3): HMAC-SHA384 over
 * `/api/{path}{nonce}{body}`, signed with the API secret, hex-encoded.
 * https://docs.bitfinex.com/docs/rest-auth
 */
export function buildAuthHeaders(params: {
  apiKey: string;
  apiSecret: string;
  path: string; // e.g. "v2/auth/w/order/submit"
  nonce: string;
  body: string; // JSON-stringified request body, "" if none
}): BfxAuthHeaders {
  const { apiKey, apiSecret, path, nonce, body } = params;
  const signaturePayload = `/api/${path}${nonce}${body}`;
  const signature = createHmac("sha384", apiSecret).update(signaturePayload).digest("hex");
  return {
    "bfx-nonce": nonce,
    "bfx-apikey": apiKey,
    "bfx-signature": signature,
  };
}

/**
 * Strictly monotonic nonce generator. Bitfinex rejects a nonce that is not
 * greater than the previous one for the same key, including across process
 * restarts in the same millisecond - so this pads with a counter, not just
 * Date.now().
 */
export class MonotonicNonce {
  private lastMs = 0;
  private counter = 0;

  next(): string {
    const now = Date.now();
    if (now === this.lastMs) {
      this.counter += 1;
    } else {
      this.lastMs = now;
      this.counter = 0;
    }
    // 1000x headroom per millisecond before collision, matches common Bitfinex client patterns.
    return String(now * 1000 + this.counter);
  }
}
