import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'
export const current = VersionInfo.of({
  version: '0.1.3:0',
  releaseNotes: {
    en_US: 'Fix stale open-trade reference on same-tick bootstrap+exit collisions; size all rotation/resize/entry/exit off real live wallet balances instead of internal NAV tracking (funding-agnostic); hold XAUT/XMR 50/50 split steady instead of resizing on regime noise, only reallocating on a real exit; route idle/new capital to the underrepresented or fully-gold pair; relabel ambiguous long/flat position display in dashboard.',
  },
  migrations: { up: async ({ effects }) => {}, down: IMPOSSIBLE },
})
