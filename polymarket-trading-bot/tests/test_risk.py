from datetime import date, timedelta

from bot.config import RiskLimits
from bot.risk import Position, RiskState, check_new_position


def make_limits(**overrides):
    defaults = dict(
        max_position_usd=500,
        per_market_max_usd=100,
        max_open_positions=5,
        max_daily_loss_usd=100,
        kelly_fraction=0.25,
        max_slippage_cents=2,
    )
    defaults.update(overrides)
    return RiskLimits(**defaults)


def test_approves_within_limits():
    state = RiskState(limits=make_limits())
    decision = check_new_position(state, "m1", 50)
    assert decision.approved
    assert decision.max_allowed_usd == 50


def test_rejects_zero_size():
    state = RiskState(limits=make_limits())
    decision = check_new_position(state, "m1", 0)
    assert not decision.approved


def test_caps_to_per_market_max():
    state = RiskState(limits=make_limits(per_market_max_usd=30))
    decision = check_new_position(state, "m1", 100)
    assert decision.approved
    assert decision.max_allowed_usd == 30


def test_rejects_when_max_open_positions_reached():
    limits = make_limits(max_open_positions=1)
    state = RiskState(limits=limits)
    state.positions["m1"] = Position("m1", 10, 0.5, "BUY_YES")
    decision = check_new_position(state, "m2", 10)
    assert not decision.approved
    assert "max open positions" in decision.reason


def test_allows_adding_to_existing_market_even_at_open_position_cap():
    limits = make_limits(max_open_positions=1, per_market_max_usd=50)
    state = RiskState(limits=limits)
    state.positions["m1"] = Position("m1", 10, 0.5, "BUY_YES")
    decision = check_new_position(state, "m1", 20)
    assert decision.approved
    assert decision.max_allowed_usd == 20


def test_kill_switch_trips_on_daily_loss_and_blocks_new_positions():
    state = RiskState(limits=make_limits(max_daily_loss_usd=50))
    today = date.today()
    state.record_realized_pnl(-60, today=today)
    assert state.kill_switch_tripped

    decision = check_new_position(state, "m1", 10, today=today)
    assert not decision.approved
    assert "kill switch" in decision.reason


def test_kill_switch_resets_on_new_day():
    state = RiskState(limits=make_limits(max_daily_loss_usd=50))
    day1 = date.today()
    day2 = day1 + timedelta(days=1)

    state.record_realized_pnl(-60, today=day1)
    assert state.kill_switch_tripped

    decision = check_new_position(state, "m1", 10, today=day2)
    assert decision.approved


def test_portfolio_exposure_cap_respected_across_markets():
    limits = make_limits(max_position_usd=60, per_market_max_usd=100, max_open_positions=5)
    state = RiskState(limits=limits)
    state.positions["m1"] = Position("m1", 50, 0.5, "BUY_YES")

    decision = check_new_position(state, "m2", 30)
    assert decision.approved
    assert decision.max_allowed_usd == 10  # only 10 left of the 60 portfolio cap
