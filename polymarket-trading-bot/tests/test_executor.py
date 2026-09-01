import pytest

from bot.executor import limit_price_with_slippage
from bot.strategy import Side


def test_buy_yes_adds_slippage_above_mid():
    price = limit_price_with_slippage(0.50, Side.BUY_YES, max_slippage_cents=2)
    assert price == 0.52


def test_buy_no_uses_inverse_price_plus_slippage():
    price = limit_price_with_slippage(0.50, Side.BUY_NO, max_slippage_cents=2)
    assert price == 0.52  # (1 - 0.50) + 0.02


def test_price_clamped_to_valid_range():
    price = limit_price_with_slippage(0.99, Side.BUY_YES, max_slippage_cents=5)
    assert price <= 0.99

    price_low = limit_price_with_slippage(0.01, Side.BUY_NO, max_slippage_cents=5)
    assert price_low <= 0.99


def test_flat_side_raises():
    with pytest.raises(ValueError):
        limit_price_with_slippage(0.5, Side.FLAT, max_slippage_cents=2)
