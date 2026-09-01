"""Pre-trade risk checks and a daily-loss kill switch.

Deliberately knows nothing about Polymarket or order execution — pure state
+ checks, so it's testable without any network access and can't be bypassed
by an executor bug.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

from bot.config import RiskLimits


@dataclass
class Position:
    market_id: str
    usd_amount: float
    entry_price: float
    side: str  # "BUY_YES" | "BUY_NO"


@dataclass
class RiskState:
    limits: RiskLimits
    positions: dict[str, Position] = field(default_factory=dict)
    realized_pnl_today: float = 0.0
    trading_day: date = field(default_factory=date.today)
    kill_switch_tripped: bool = False

    def _roll_day_if_needed(self, today: date) -> None:
        if today != self.trading_day:
            self.trading_day = today
            self.realized_pnl_today = 0.0
            self.kill_switch_tripped = False

    def total_exposure_usd(self) -> float:
        return sum(p.usd_amount for p in self.positions.values())

    def record_realized_pnl(self, amount: float, today: date | None = None) -> None:
        self._roll_day_if_needed(today or date.today())
        self.realized_pnl_today += amount
        if self.realized_pnl_today <= -abs(self.limits.max_daily_loss_usd):
            self.kill_switch_tripped = True

    def budget_remaining_usd(self) -> float:
        return max(0.0, self.limits.max_position_usd - self.total_exposure_usd())


@dataclass(frozen=True)
class RiskDecision:
    approved: bool
    reason: str
    max_allowed_usd: float = 0.0


def check_new_position(
    state: RiskState, market_id: str, requested_usd: float, today: date | None = None
) -> RiskDecision:
    state._roll_day_if_needed(today or date.today())

    if state.kill_switch_tripped:
        return RiskDecision(False, "kill switch tripped: daily loss limit reached")

    if requested_usd <= 0:
        return RiskDecision(False, "requested size is zero")

    if market_id not in state.positions and len(state.positions) >= state.limits.max_open_positions:
        return RiskDecision(False, "max open positions reached")

    existing = state.positions.get(market_id)
    existing_usd = existing.usd_amount if existing else 0.0
    per_market_room = max(0.0, state.limits.per_market_max_usd - existing_usd)
    if per_market_room <= 0:
        return RiskDecision(False, "per-market cap reached")

    portfolio_room = state.budget_remaining_usd()
    if portfolio_room <= 0:
        return RiskDecision(False, "portfolio max exposure reached")

    max_allowed = min(requested_usd, per_market_room, portfolio_room)
    if max_allowed <= 0:
        return RiskDecision(False, "no room within risk limits")

    return RiskDecision(True, "ok", max_allowed_usd=round(max_allowed, 2))
