import { createRequire } from "node:module";
import type { DatabaseSyncLike } from "./types.js";

const require = createRequire(import.meta.url);

/**
 * Opens a SQLite database via Node's built-in `node:sqlite` (stable enough
 * for this project as of Node 22, still flagged experimental upstream - run
 * with `--experimental-sqlite` until it graduates). Using the built-in avoids
 * a native-module build step (better-sqlite3) for local dev; swap here if
 * that becomes a problem in a specific deployment target.
 */
export function openDatabase(path: string): DatabaseSyncLike {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => DatabaseSyncLike;
  };
  return new DatabaseSync(path);
}
