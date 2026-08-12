import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'
export const current = VersionInfo.of({
  version: '0.1.6:0',
  releaseNotes: {
    en_US: 'Fix a real production bug that was blocking every LIVE tick: the bootstrap wallet-position check compared a pair's own asset value against the FULL pooled BTC wallet balance (shared across both pairs) instead of just checking whether the pair holds a meaningful amount of its own asset. At a clean 50/50 dual-gold split this made the comparison a coin flip, and it flipped XAUT to a wrongly-inferred long/BTC position, triggering a needless real rotation attempt that then failed on the exchange minimum order size and threw on every subsequent tick. Fixed and covered with a regression test reproducing the exact real incident numbers.',
  },
  migrations: { up: async ({ effects }) => {}, down: IMPOSSIBLE },
})
