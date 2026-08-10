import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/rateLimiter.js";

describe("RateLimiter", () => {
  it("allows up to maxTokens immediately, then blocks", () => {
    const limiter = new RateLimiter(3, 1 / 1000, 0);
    expect(limiter.tryAcquire(0)).toBe(true);
    expect(limiter.tryAcquire(0)).toBe(true);
    expect(limiter.tryAcquire(0)).toBe(true);
    expect(limiter.tryAcquire(0)).toBe(false);
  });

  it("refills over time", () => {
    const limiter = new RateLimiter(1, 1 / 1000, 0); // 1 token per 1000ms
    expect(limiter.tryAcquire(0)).toBe(true);
    expect(limiter.tryAcquire(500)).toBe(false);
    expect(limiter.tryAcquire(1000)).toBe(true);
  });

  it("reports ms until next token is available", () => {
    const limiter = new RateLimiter(1, 1 / 1000, 0);
    limiter.tryAcquire(0);
    expect(limiter.msUntilNextToken(0)).toBeGreaterThan(0);
  });
});
