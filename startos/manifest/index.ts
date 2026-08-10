import { setupManifest } from '@start9labs/start-sdk'
import { long, short } from './i18n'

export const manifest = setupManifest({
  id: 'btc-yield-autopilot',
  title: 'BTC Yield Autopilot',
  license: 'MIT',
  packageRepo: 'https://github.com/syedasaadbilal-afk/btc-yield-autopilot-startos',
  upstreamRepo: 'https://github.com/syedasaadbilal-afk/btc-yield-autopilot-startos',
  marketingUrl: 'https://github.com/syedasaadbilal-afk/btc-yield-autopilot-startos',
  donationUrl: 'https://github.com/syedasaadbilal-afk/btc-yield-autopilot-startos',
  description: { short, long },
  volumes: ['main'],
  images: {
    autopilot: {
      // Built + pushed by .github/workflows/build.yml on every push to
      // main. Bump this tag (and re-run `make`) whenever you want a new
      // image baked into the .s9pk - see the versions/current.ts revision
      // bump convention this package follows.
      source: { dockerTag: 'ghcr.io/syedasaadbilal-afk/btc-yield-autopilot-startos:latest' },
      arch: ['x86_64', 'aarch64'],
    },
  },
  alerts: {
    install: null,
    update: null,
    uninstall: null,
    restore: null,
    start: null,
    stop: null,
  },
  dependencies: {},
})
