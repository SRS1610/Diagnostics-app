"""Polymarket CLOB market data access (REST).

Kept separate from strategy so strategy logic never needs network access to
be tested.
"""
from __future__ import annotations

from dataclasses import dataclass

import requests


@dataclass(frozen=True)
class OrderBookTop:
    best_bid: float
    best_ask: float

    @property
    def mid_price(self) -> float:
        return (self.best_bid + self.best_ask) / 2


@dataclass(frozen=True)
class MarketTokens:
    condition_id: str
    yes_token_id: str
    no_token_id: str


class MarketDataClient:
    def __init__(self, clob_host: str, timeout_sec: float = 10.0) -> None:
        self._host = clob_host.rstrip("/")
        self._timeout = timeout_sec

    def get_market_tokens(self, condition_id: str) -> MarketTokens:
        resp = requests.get(
            f"{self._host}/markets/{condition_id}", timeout=self._timeout
        )
        resp.raise_for_status()
        data = resp.json()

        tokens = data.get("tokens") or []
        yes_id = next((t["token_id"] for t in tokens if t.get("outcome") == "Yes"), None)
        no_id = next((t["token_id"] for t in tokens if t.get("outcome") == "No"), None)
        if not yes_id or not no_id:
            raise ValueError(f"could not resolve YES/NO tokens for market {condition_id}")

        return MarketTokens(condition_id=condition_id, yes_token_id=yes_id, no_token_id=no_id)

    def get_order_book_top(self, token_id: str) -> OrderBookTop:
        """Fetch best bid/ask for a CLOB token (one side of a binary
        market's YES/NO pair)."""
        resp = requests.get(
            f"{self._host}/book", params={"token_id": token_id}, timeout=self._timeout
        )
        resp.raise_for_status()
        data = resp.json()

        bids = data.get("bids") or []
        asks = data.get("asks") or []
        if not bids or not asks:
            raise ValueError(f"empty order book for token {token_id}")

        best_bid = max(float(b["price"]) for b in bids)
        best_ask = min(float(a["price"]) for a in asks)
        return OrderBookTop(best_bid=best_bid, best_ask=best_ask)
