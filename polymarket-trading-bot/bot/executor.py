"""Order execution: dry-run (default) vs live via py-clob-client.

Orders are always limit orders bounded by a slippage tolerance — never
market orders — to avoid blowing through a thin book.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from bot.config import Config
from bot.strategy import Side

logger = logging.getLogger("polymarket_bot.executor")


@dataclass(frozen=True)
class OrderResult:
    submitted: bool
    order_id: str | None
    detail: str


class Executor:
    def __init__(self, config: Config) -> None:
        self._config = config
        self._clob_client = None  # lazily constructed only for live trading

    def _live_client(self):
        if self._clob_client is not None:
            return self._clob_client

        self._config.require_live_credentials()
        # Imported lazily so dry-run mode never requires py-clob-client's
        # transitive deps (web3, etc.) to be importable.
        from py_clob_client.client import ClobClient
        from py_clob_client.clob_types import ApiCreds

        creds = ApiCreds(
            api_key=self._config.poly_api_key,
            api_secret=self._config.poly_api_secret,
            api_passphrase=self._config.poly_api_passphrase,
        )
        self._clob_client = ClobClient(
            self._config.clob_host,
            key=self._config.private_key,
            chain_id=self._config.chain_id,
            creds=creds,
        )
        return self._clob_client

    def place_limit_order(
        self,
        token_id: str,
        side: Side,
        usd_amount: float,
        limit_price: float,
    ) -> OrderResult:
        if side not in (Side.BUY_YES, Side.BUY_NO):
            return OrderResult(False, None, f"nothing to execute for side={side}")

        if self._config.dry_run:
            logger.info(
                "[DRY RUN] would BUY token=%s usd=%.2f limit_price=%.4f",
                token_id,
                usd_amount,
                limit_price,
            )
            return OrderResult(False, None, "dry_run")

        client = self._live_client()
        from py_clob_client.clob_types import OrderArgs
        from py_clob_client.order_builder.constants import BUY

        size = usd_amount / limit_price
        order_args = OrderArgs(
            token_id=token_id,
            price=limit_price,
            size=round(size, 2),
            side=BUY,
        )
        signed_order = client.create_order(order_args)
        response = client.post_order(signed_order)
        order_id = response.get("orderID") if isinstance(response, dict) else None
        logger.info("LIVE order submitted token=%s usd=%.2f order_id=%s", token_id, usd_amount, order_id)
        return OrderResult(True, order_id, "submitted")


def limit_price_with_slippage(mid_price: float, side: Side, max_slippage_cents: float) -> float:
    """Bound the limit price so the order can't chase a thin book past the
    configured slippage tolerance. Price is in [0, 1] dollars; slippage is
    expressed in cents for readability in config."""
    slippage = max_slippage_cents / 100.0
    if side == Side.BUY_YES:
        price = mid_price + slippage
    elif side == Side.BUY_NO:
        # "buying NO" is expressed here as buying the NO token; its price
        # moves inversely to the YES mid price.
        price = (1 - mid_price) + slippage
    else:
        raise ValueError(f"no limit price for side={side}")
    return max(0.01, min(0.99, round(price, 4)))
