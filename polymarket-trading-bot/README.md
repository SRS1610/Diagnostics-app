# Polymarket Trading Bot

An automated trading bot for [Polymarket](https://polymarket.com) prediction
markets, built around a systematic, risk-managed strategy rather than
discretionary "gut feel" trading.

**Standalone project.** This lives outside the Diagnostics-app monorepo
(different language, different domain, different risk profile — real money,
private key signing) and has no dependency on it.

## Read this before running it live

- **This is not financial advice, and there is no proven edge shipped here.**
  The included strategy (mean-reversion on short-term price deviation) is a
  reasonable, well-known systematic approach — it is *not* validated against
  real Polymarket history. Backtest it yourself (see `backtest.py`) against
  real market data before risking real money, and expect to iterate on or
  replace the signal entirely.
- **Defaults to dry-run.** `DRY_RUN=true` is the default in `.env.example`.
  In dry-run, the bot computes signals and logs the orders it *would* place
  but never signs or submits anything. You must explicitly set `DRY_RUN=false`
  and provide real credentials to trade live.
- **Prediction markets are not stocks.** A Polymarket price is a probability
  that converges to 0 or 100 at resolution. "Mean reversion" here is a bet
  that short-term price wobbles are noise around a stable fair value — that
  assumption can be wrong, especially around news events, where a price move
  is real information, not noise the bot should trade against. Tune
  `Z_SCORE_ENTRY` conservatively and never remove the risk limits below.
- **Wallet keys.** Live trading needs a funded Polygon wallet and Polymarket
  CLOB API credentials (`py-clob-client`). Keep `PRIVATE_KEY` in `.env`
  (untracked — see `.gitignore`), never in code, logs, or version control.
  Use a wallet funded only with what you're willing to lose to bot bugs.

## Architecture

```
bot/
  config.py       env-driven configuration (risk limits, strategy params)
  market_data.py  Polymarket CLOB market/order-book access (REST)
  strategy.py     signal generation (pluggable; ships MeanReversionStrategy)
  sizing.py       fractional-Kelly position sizing with hard caps
  risk.py         pre-trade risk checks + daily-loss kill switch
  executor.py     order placement; dry-run vs live (py-clob-client)
  logging_setup.py
  runner.py       main loop: poll -> signal -> risk check -> size -> execute
backtest.py       offline strategy validation against a CSV of past prices
tests/            unit tests for strategy/sizing/risk (no network required)
```

Each stage is a pure, independently testable unit — the risk manager and
position sizer don't know about Polymarket at all, so they're testable
without any network access or credentials.

## Setup

```bash
cd polymarket-trading-bot
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in credentials for live trading; leave DRY_RUN=true to start
```

Run the bot:

```bash
python -m bot.runner
```

Run the test suite (pure logic, no network/credentials needed):

```bash
pytest tests/
```

Backtest the strategy against historical prices before ever going live:

```bash
python backtest.py --csv path/to/market_price_history.csv
```

## Risk controls (all enforced in `bot/risk.py`, not optional)

- `MAX_POSITION_USD` — total notional exposure across all open positions
- `PER_MARKET_MAX_USD` — max notional in any single market
- `MAX_OPEN_POSITIONS` — cap on number of concurrent positions
- `MAX_DAILY_LOSS_USD` — kill switch: once tripped, the bot stops opening
  new positions for the rest of the trading day (existing positions are left
  alone, not force-liquidated — a panic-sell into a thin book can lock in a
  worse loss than holding)
- Orders are placed as **limit orders** near the best bid/ask with a bounded
  slippage tolerance — never market orders — to avoid blowing through a thin
  order book

## What this bot does NOT do

- No arbitrage across venues or logically-linked markets (a separate,
  lower-risk strategy family worth building if this direction is validated)
- No market-making / two-sided quoting
- No machine-learning price model — the shipped signal is a simple,
  auditable z-score, deliberately, so its behavior is predictable
- No automatic position flattening on kill-switch trip (see above)
