import { sdk } from '../sdk'

// Bitfinex API credentials are entered through the dashboard's Config tab
// (persisted to a file in the data volume - see packages/daemon/src/
// secrets.ts) rather than a native StartOS Action, so this stays empty for
// now, matching this same pattern in the reference hashrate-autopilot
// package.
export const actions = sdk.Actions.of()
