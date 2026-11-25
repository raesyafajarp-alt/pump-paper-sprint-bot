# Pump Paper Sprint Bot

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/raesyafajarp-alt/pump-paper-sprint-bot/rank.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/raesyafajarp-alt/pump-paper-sprint-bot/reward.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for make.fun's **Pump.fun Paper Sprint: Any Bot Can Win** — it trades pump.fun bonding curves on a 6-hour replay, ranked by net PnL. Paper trading only; no real funds.

## Strategy

Two tiers, validated offline on the competition's full 24h dev dataset (all three parts, kit replay model: fills 2 slots after the decision, curve fees 95 + 30 bps, 105,000 lamports tx fee, seeded 2% tx failures):

- **Tier A — probe:** when a coin first reaches **1.5x** its create price and its size cap covers the probe, buy **0.011 SOL**. Take profit **+20%**, stop loss **−15%**, max hold 1,500 slots (~10 min).
- **Tier B — press:** when a coin reaches **8.0x** its create price, buy **0.60 SOL** (or the 1%-of-real-reserve cap, when smaller but still ≥ 0.10 SOL). Take profit **+40%**, stop loss **−30%**, max hold 3,000 slots (~20 min). A coin already probed by Tier A is topped up to Tier B instead of a second fresh entry; a coin whose Tier A probe already exited may still earn a fresh Tier B entry later.
- **Exits:** take-profit, stop-loss, max hold, or the creator selling while held. Creator sells do not block entry (tested: the filter cost PnL on the dev window).

## Backtest (dev window, offline)

- **Net +1.30 SOL** on 10 SOL capital (+13.0%), max drawdown **2.8%**
- **877 fills, 433 distinct mints** (guardrail needs ≥ 20), 126 winning / 317 losing coins
- PnL is concentrated: the top 3 coins made +0.355 / +0.241 / +0.241 SOL — the final 6h window's result depends on whether it holds a mooner. That is the bet this bot makes.

## Run

`main.ts` runs on Node 22 under the `agent-fun/replay/v2` harness (`node main.ts`); the protocol shim is vendored at `vendor/makefun-bot.ts`. The bot is a pure function of the batches it is fed — no clock, no randomness, no I/O — so its two grading executions produce byte-identical action logs.

## License

MIT — see [LICENSE](LICENSE).
