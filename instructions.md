# BTC Yield Autopilot

## Setup

1. Open the **Config** tab and enter your Bitfinex API key and secret under "Bitfinex API credentials." These are stored in the service's data volume, never baked into the image.
2. Restart the service (Actions → Restart) so the daemon picks up the new credentials.
3. Confirm the service starts in **DRY_RUN** mode (the default) and looks correct on the Status tab before switching to LIVE.

## Usage

The Status tab shows current portfolio allocation and PnL. The Timeline tab shows the history of rebalancing decisions and trades. Switch between DRY_RUN and LIVE from the Config tab once you're confident in the strategy's behavior.

## Support

This is an experimental automated trading tool. Use at your own risk, and never allocate more capital than you can afford to lose.
