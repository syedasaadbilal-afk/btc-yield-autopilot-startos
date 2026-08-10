import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSyncLike } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");

/**
 * Applies any .sql files in /migrations not yet recorded in _migrations, in
 * filename order (numeric prefix). Idempotent - safe to call on every daemon
 * start (design doc: "SQLite with migrations").
 */
export function applyMigrations(db: DatabaseSyncLike, migrationsDir: string = MIGRATIONS_DIR): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const applied = new Set(
    db.prepare("SELECT filename FROM _migrations").all().map((r) => (r as { filename: string }).filename)
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    db.exec(sql);
    db.prepare("INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)").run(file, Date.now());
  }
}
