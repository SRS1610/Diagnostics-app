from bot.sizing import kelly_fraction_of_bankroll, size_position


def test_zero_confidence_sizes_to_zero():
    result = size_position(confidence=0.0, kelly_fraction=0.25, available_budget_usd=100, per_market_max_usd=50)
    assert result.usd_amount == 0.0


def test_no_budget_sizes_to_zero():
    result = size_position(confidence=1.0, kelly_fraction=0.25, available_budget_usd=0, per_market_max_usd=50)
    assert result.usd_amount == 0.0


def test_full_confidence_respects_kelly_fraction():
    result = size_position(confidence=1.0, kelly_fraction=0.25, available_budget_usd=1000, per_market_max_usd=1000)
    assert result.usd_amount == 250.0  # 1.0 * 0.25 * 1000


def test_never_exceeds_per_market_cap():
    result = size_position(confidence=1.0, kelly_fraction=0.9, available_budget_usd=1000, per_market_max_usd=50)
    assert result.usd_amount == 50.0


def test_never_exceeds_available_budget():
    result = size_position(confidence=1.0, kelly_fraction=0.9, available_budget_usd=30, per_market_max_usd=1000)
    assert result.usd_amount == 27.0  # 1.0 * 0.9 * 30


def test_kelly_fraction_is_ceiling_not_exact():
    frac = kelly_fraction_of_bankroll(confidence=0.5, kelly_fraction=0.25)
    assert frac == 0.125
    frac_full = kelly_fraction_of_bankroll(confidence=1.0, kelly_fraction=0.25)
    assert frac_full == 0.25
