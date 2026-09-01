import pytest

from bot.strategy import MeanReversionStrategy, Side


def test_flat_until_lookback_filled():
    s = MeanReversionStrategy(lookback_ticks=5, z_entry=2.0, z_exit=0.5)
    for _ in range(4):
        sig = s.update("m1", 0.5)
        assert sig.side == Side.FLAT
        assert sig.confidence == 0.0


def test_flat_when_no_variance():
    s = MeanReversionStrategy(lookback_ticks=5, z_entry=2.0, z_exit=0.5)
    for _ in range(6):
        sig = s.update("m1", 0.5)
    assert sig.side == Side.FLAT  # stdev == 0


def test_buy_yes_on_downward_dip():
    s = MeanReversionStrategy(lookback_ticks=5, z_entry=1.0, z_exit=0.5)
    prices = [0.50, 0.51, 0.49, 0.50, 0.10]  # sharp dip
    sig = None
    for p in prices:
        sig = s.update("m1", p)
    assert sig.side == Side.BUY_YES
    assert sig.z_score < 0
    assert 0 < sig.confidence <= 1.0


def test_buy_no_on_upward_spike():
    s = MeanReversionStrategy(lookback_ticks=5, z_entry=1.0, z_exit=0.5)
    prices = [0.50, 0.49, 0.51, 0.50, 0.90]  # sharp spike
    sig = None
    for p in prices:
        sig = s.update("m1", p)
    assert sig.side == Side.BUY_NO
    assert sig.z_score > 0


def test_rejects_out_of_range_price():
    s = MeanReversionStrategy(lookback_ticks=5, z_entry=2.0, z_exit=0.5)
    with pytest.raises(ValueError):
        s.update("m1", 1.5)


def test_rejects_tiny_lookback():
    with pytest.raises(ValueError):
        MeanReversionStrategy(lookback_ticks=2, z_entry=2.0, z_exit=0.5)


def test_markets_are_independent():
    s = MeanReversionStrategy(lookback_ticks=5, z_entry=1.0, z_exit=0.5)
    for p in [0.50, 0.51, 0.49, 0.50, 0.10]:
        s.update("m1", p)
    # a fresh market shouldn't inherit m1's history/signal
    sig = s.update("m2", 0.5)
    assert sig.side == Side.FLAT
