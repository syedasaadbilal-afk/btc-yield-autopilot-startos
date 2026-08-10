import fs from "node:fs";
import path from "node:path";

export interface BitfinexSecrets {
  apiKey: string;
  apiSecret: string;
}

/**
 * Bitfinex API credentials, file-based (colocated with the SQLite DB inside
 * the mounted data volume) rather than baked into the Docker image or a
 * committed manifest env var. Two reasons: (1) StartOS packages are pulled
 * from a public image reference (see startos/manifest/index.ts's dockerTag)
 * - anything in that image or in this repo's git history is effectively
 * public, so real API secrets can never live there; (2) this matches the
 * "no rebuild to tune" philosophy already used for run mode (repo.ts) -
 * rotating a compromised key shouldn't require a new image build/redeploy.
 * Falls back to BFX_API_KEY/BFX_API_SECRET env vars (the old raw-podman
 * deployment's mechanism) so existing deployments keep working unchanged
 * until they're migrated onto the file-based path via the dashboard.
 */
function secretsPath(dbPath: string): string {
  return path.join(path.dirname(dbPath), "bfx-secrets.json");
}

export function readBitfinexSecrets(dbPath: string): BitfinexSecrets {
  const file = secretsPath(dbPath);
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<BitfinexSecrets>;
      if (parsed.apiKey && parsed.apiSecret) {
        return { apiKey: parsed.apiKey, apiSecret: parsed.apiSecret };
      }
    }
  } catch (err) {
    console.warn(`[autopilot] failed to read ${file}, falling back to env vars: ${err instanceof Error ? err.message : String(err)}`);
  }
  return {
    apiKey: process.env.BFX_API_KEY ?? "",
    apiSecret: process.env.BFX_API_SECRET ?? "",
  };
}

/** Writes credentials with 0600 permissions (owner read/write only) - this file holds trading-capable API secrets. */
export function writeBitfinexSecrets(dbPath: string, secrets: BitfinexSecrets): void {
  const file = secretsPath(dbPath);
  fs.writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
  fs.chmodSync(file, 0o600); // belt-and-suspenders in case the file already existed with looser permissions
}

/** Whether real (non-empty) credentials are configured, without ever exposing the values themselves over the API. */
export function hasBitfinexSecrets(dbPath: string): boolean {
  const s = readBitfinexSecrets(dbPath);
  return s.apiKey.length > 0 && s.apiSecret.length > 0;
}
