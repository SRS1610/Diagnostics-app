"""Position sizing: fractional Kelly, hard-capped.

Kelly sizing needs a real probability edge and payout odds. We don't have a
calibrated probability model here (see strategy.py) — we treat the
strategy's 0..1 confidence as a rough proxy for edge and deliberately use a
small Kelly fraction plus hard USD caps so a bad or noisy signal can't sink
a large fraction of the bankroll on its own.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SizeResult:
    usd_amount: float
    reason: str


def kelly_fraction_of_bankroll(confidence: float, kelly_fraction: float) -> float:
    """Return the fraction of bankroll to risk, in [0, kelly_fraction].

    confidence in [0, 1] stands in for edge strength (see strategy._confidence).
    We scale linearly rather than plugging into the full Kelly formula
    (edge/odds) because we don't have calibrated win-probability estimates —
    doing so would be false precision. kelly_fraction is the ceiling: with
    the recommended default of 0.25, a maximum-confidence signal risks at
    most 25% of whatever budget is passed in, never the whole bankroll.
    """
    confidence = max(0.0, min(1.0, confidence))
    return confidence * kelly_fraction


def size_position(
    confidence: float,
    kelly_fraction: float,
    available_budget_usd: float,
    per_market_max_usd: float,
) -> SizeResult:
    if confidence <= 0:
        return SizeResult(0.0, "no confidence in signal")
    if available_budget_usd <= 0:
        return SizeResult(0.0, "no risk budget remaining")

    fraction = kelly_fraction_of_bankroll(confidence, kelly_fraction)
    raw_amount = fraction * available_budget_usd
    capped_amount = min(raw_amount, per_market_max_usd, available_budget_usd)

    if capped_amount <= 0:
        return SizeResult(0.0, "capped size rounded to zero")

    return SizeResult(round(capped_amount, 2), "ok")
