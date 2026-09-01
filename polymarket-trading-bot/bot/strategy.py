"""Signal generation.

Ships one strategy: short-window mean reversion via z-score. This is a
deliberately simple, auditable signal — not a claim of proven edge. See
README "Read this before running it live".
"""
from __future__ import annotations

import statistics
from collections import deque
from dataclasses import dataclass
from enum import Enum


class Side(Enum):
    BUY_YES = "BUY_YES"
    BUY_NO = "BUY_NO"
    FLAT = "FLAT"


@dataclass(frozen=True)
class Signal:
    side: Side
    z_score: float
    confidence: float  # 0..1, derived from |z_score|, used by position sizer


class MeanReversionStrategy:
    """Tracks a rolling window of mid-prices per market and signals a bet
    that the price reverts toward its recent mean.

    z = (last_price - rolling_mean) / rolling_stdev
    z <= -entry -> price dipped below trend -> BUY_YES (bet it reverts up)
    z >=  entry -> price spiked above trend -> BUY_NO  (bet it reverts down)
    |z| <= exit  -> no edge, FLAT
    """

    def __init__(self, lookback_ticks: int, z_entry: float, z_exit: float) -> None:
        if lookback_ticks < 3:
            raise ValueError("lookback_ticks must be >= 3 to compute a stdev")
        self.lookback_ticks = lookback_ticks
        self.z_entry = z_entry
        self.z_exit = z_exit
        self._history: dict[str, deque[float]] = {}

    def update(self, market_id: str, mid_price: float) -> Signal:
        if not (0.0 < mid_price < 1.0):
            raise ValueError(f"mid_price must be in (0, 1), got {mid_price}")

        window = self._history.setdefault(market_id, deque(maxlen=self.lookback_ticks))
        window.append(mid_price)

        if len(window) < self.lookback_ticks:
            return Signal(Side.FLAT, z_score=0.0, confidence=0.0)

        mean = statistics.mean(window)
        stdev = statistics.pstdev(window)
        if stdev == 0:
            return Signal(Side.FLAT, z_score=0.0, confidence=0.0)

        z = (mid_price - mean) / stdev

        if z <= -self.z_entry:
            return Signal(Side.BUY_YES, z_score=z, confidence=_confidence(z, self.z_entry))
        if z >= self.z_entry:
            return Signal(Side.BUY_NO, z_score=z, confidence=_confidence(z, self.z_entry))
        return Signal(Side.FLAT, z_score=z, confidence=0.0)


def _confidence(z: float, z_entry: float) -> float:
    """Map |z| beyond the entry threshold to a 0..1 confidence, saturating
    at 1.0 by 2x the entry threshold. This is a heuristic edge estimate,
    not a calibrated probability — sizing.py treats it as such."""
    excess = abs(z) - z_entry
    span = z_entry  # reach confidence 1.0 at |z| == 2 * z_entry
    return max(0.0, min(1.0, excess / span))
