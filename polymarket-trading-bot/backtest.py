"""Offline strategy validation against historical prices.

Expects a CSV with columns: timestamp,price (price in (0,1), one market per
file). This is intentionally simple — no fills, no slippage, no fees, one
position at a time — good enough to sanity-check whether the signal has any
directional value before wiring up real execution. Do not treat backtest
P&L here as a live-performance guarantee.

Usage: python backtest.py --csv path/to/history.csv
"""
from __future__ import annotations

import argparse
import csv

from bot.strategy import MeanReversionStrategy, Side


def run_backtest(rows: list[tuple[str, float]], lookback: int, z_entry: float, z_exit: float) -> dict:
    strategy = MeanReversionStrategy(lookback_ticks=lookback, z_entry=z_entry, z_exit=z_exit)

    position: str | None = None  # "BUY_YES" | "BUY_NO" | None
    entry_price = 0.0
    trades = 0
    wins = 0
    total_pnl = 0.0

    for _, price in rows:
        signal = strategy.update("backtest", price)

        if position is None and signal.side in (Side.BUY_YES, Side.BUY_NO):
            position = signal.side.value
            entry_price = price
            trades += 1
        elif position is not None and abs(signal.z_score) <= z_exit:
            pnl = (price - entry_price) if position == "BUY_YES" else (entry_price - price)
            total_pnl += pnl
            if pnl > 0:
                wins += 1
            position = None

    return {
        "trades": trades,
        "closed_trades": wins + (trades - (1 if position else 0) - wins),
        "wins": wins,
        "total_pnl_per_share": round(total_pnl, 4),
        "still_open": position is not None,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", required=True, help="CSV with columns: timestamp,price")
    parser.add_argument("--lookback", type=int, default=30)
    parser.add_argument("--z-entry", type=float, default=2.0)
    parser.add_argument("--z-exit", type=float, default=0.5)
    args = parser.parse_args()

    rows = []
    with open(args.csv, newline="") as f:
        for row in csv.DictReader(f):
            rows.append((row["timestamp"], float(row["price"])))

    if len(rows) <= args.lookback:
        raise SystemExit(f"need more than {args.lookback} rows, got {len(rows)}")

    result = run_backtest(rows, args.lookback, args.z_entry, args.z_exit)
    print(f"rows analyzed: {len(rows)}")
    for k, v in result.items():
        print(f"{k}: {v}")


if __name__ == "__main__":
    main()
