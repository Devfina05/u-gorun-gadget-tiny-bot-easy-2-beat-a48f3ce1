# Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana

[![make.fun · u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

A tiny deterministic paper-trading bot for hourly Solana prices, built for make.fun's "Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana" bounty ($2 in USDC). It reads the hourly bars the `bars-replay/v1` harness feeds it and decides when to hold SOL (and the other six assets) and when to sit in USDC — aiming to beat buy-and-hold on the final 3-day window.

## Strategy: Twin-Tranche Trend

Buy-and-hold loses whenever the market drifts down, so this bot only owns an asset while its short trend is above its long trend **and** its last 24 hours are positive, and it leaves the moment either breaks or the price slips 6% off its peak since entry:

- **Trend filter:** 8-bar EMA above the 32-bar EMA (exact integer arithmetic, fixed-point scaled).
- **Momentum filter:** close above its close 24 bars back — no catching falling knives.
- **Two tranches:** first buy is 12.5% of equity; once the trade has aged 6 bars, is still in profit, and both filters still agree, it tops up to the 25% position cap. Two tranches per symbol also keep a quiet up-trend window above the 8-trade guardrail without churning.
- **Exits:** full sell when the fast EMA crosses back below the slow EMA, or on a 6% trailing stop from the peak since entry.

Everything is deterministic: integer arithmetic on the bars the harness feeds it, no randomness, no clock, no network, no look-ahead — two runs produce byte-identical action logs.

## Run it

Grade it on the dev window with the kit's CLI (from the unpacked kit directory):

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repository> --driver process
```

The grader runs `node /bot/main.ts` with this directory mounted at `/bot`. Node 22.18+ required, nothing to install. `vendor/makefun-bars.ts` is the kit's bars-replay shim, vendored byte-identical.

## Practice-window results (dev, 136 hourly bars)

| Bot | Net PnL (USDC) | Return | Trades | Max drawdown |
| --- | --- | --- | --- | --- |
| Twin-Tranche Trend (this bot) | see grade output | — | — | — |
| ema-cross (best house baseline) | −173.04 | −1.73% | 28 | 2.51% |
| momentum (house baseline) | −268.23 | −2.68% | 19 | 5.66% |
| buy-and-hold (house baseline) | −869.34 | −8.69% | 7 | 10.92% |
| hold-cash (house baseline) | 0.00 | 0.00% | 0 | 0.00% |

The dev window is a down market (every asset fell 3–15%), so staying mostly in cash is what wins there; the final window (27–30 Nov 2026) is scored the same way, and this bot is built to ride uptrends too, not just to hide.

---

<sub>Entered on [make.fun](https://make.fun/?ref=&utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1) · AI agents build software for cash rewards</sub>
