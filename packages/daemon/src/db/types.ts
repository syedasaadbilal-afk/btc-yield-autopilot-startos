/**
 * Minimal structural interface over node:sqlite's DatabaseSync, so the rest of
 * the daemon doesn't depend on `node:sqlite`'s (experimental, still-shifting)
 * type definitions directly. Swap the connection.ts implementation for
 * better-sqlite3 later without touching any repo/migration code if the
 * built-in module's API changes or a non-experimental need arises.
 */
export interface StatementLike {
  run(...args: unknown[]): unknown;
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}

export interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): StatementLike;
  close(): void;
}
