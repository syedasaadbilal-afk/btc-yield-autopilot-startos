import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'
export const current = VersionInfo.of({
  version: '0.1.14:0',
  releaseNotes: {
    en_US: 'Status tab shows BTC versus its 4-year SMA with the XAUT entry block state; closed trades show the signal return under the actual return. Fixes the Portfolio NAV double count after an exit and the stale rotation pending status. Adds an optional XAUT entry block (Config tab): no new XAUT entries while BTC is below a chosen multiple of its 4-year SMA, default 1.5x, off by default. Adds a leftover sweep: any asset left after an exit and any idle USDT above the required cash is converted to BTC (USDT is kept when a pair currently wants its asset). Closed trades are now valued on real fills: entry is the average cost of every buy during the hold (entry plus top-ups), exit is the real average sell price, and PnL is computed on the units actually sold, with the signal-based figure shown beneath. The Timeline also shows the BTC leg of an execution (the BTC bought with the proceeds of an exit).',
  },
  migrations: { up: async ({ effects }) => {}, down: IMPOSSIBLE },
})
