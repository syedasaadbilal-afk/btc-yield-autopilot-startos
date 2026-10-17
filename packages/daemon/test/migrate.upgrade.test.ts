import { mkdtempSync, readdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { applyMigrations } from "../src/db/migrate.js";
import { Repo } from "../src/db/repo.js";

/** Simulates the real upgrade: a DB that already ran migrations 001-011 gets 012-014 on top. */
describe("upgrade from the v0.1.6 schema", () => {
  it("keeps existing rows, adds the new columns, and drops only blocked top-ups", () => {
    const all = readdirSync(join(__dirname, "..", "migrations")).filter((f) => f.endsWith(".sql")).sort();
    const old = mkdtempSync(join(tmpdir(), "mig-"));
    for (const f of all.filter((f) => Number(f.slice(0, 3)) <= 11)) copyFileSync(join(__dirname, "..", "migrations", f), join(old, f));
    const db = openDatabase(":memory:");
    applyMigrations(db, old);
    const ins = db.prepare(
      "INSERT INTO execution_log (id, pair_key, timestamp, kind, side, requested_btc, moved_btc, status, routes) VALUES (?, 'xmr', ?, ?, 'sell_btc_for_xaut', 0.0001, ?, ?, 'x')"
    );
    ins.run("a", 1, "topup", 0, "blocked");
    ins.run("b", 2, "topup", 0.0001, "executed");
    ins.run("c", 3, "resize", 0, "blocked");
    applyMigrations(db); // real migrations dir: applies 012, 013, 014
    const repo = new Repo(db);
    const rows = repo.getRecentExecutions("xmr", 10).map((r) => r.id).sort();
    expect(rows).toEqual(["b", "c"]); // blocked top-up removed; blocked resize kept
    expect(repo.getRecentExecutions("xmr", 10)[0]!.orderCount).toBeUndefined();
    // Backfill bookkeeping works on the upgraded DB.
    expect(repo.isBackfillDone("x")).toBe(false);
    repo.markBackfillDone("x");
    expect(repo.isBackfillDone("x")).toBe(true);
    applyMigrations(db); // idempotent re-run with the backfill marker present
  });
});
