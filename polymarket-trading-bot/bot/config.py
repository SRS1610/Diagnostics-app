"""Env-driven configuration. No secrets have defaults baked in here."""
from __future__ import annotations

import os
from dataclasses import dataclass, field

from dotenv import load_dotenv

load_dotenv()


def _bool(name: str, default: bool) -> bool:
    val = os.getenv(name)
    if val is None:
        return default
    return val.strip().lower() in ("1", "true", "yes", "on")


def _float(name: str, default: float) -> float:
    val = os.getenv(name)
    return float(val) if val else default


def _int(name: str, default: int) -> int:
    val = os.getenv(name)
    return int(val) if val else default


@dataclass(frozen=True)
class RiskLimits:
    max_position_usd: float
    per_market_max_usd: float
    max_open_positions: int
    max_daily_loss_usd: float
    kelly_fraction: float
    max_slippage_cents: float


@dataclass(frozen=True)
class StrategyParams:
    lookback_ticks: int
    z_score_entry: float
    z_score_exit: float


@dataclass(frozen=True)
class Config:
    dry_run: bool
    private_key: str
    poly_api_key: str
    poly_api_secret: str
    poly_api_passphrase: str
    clob_host: str
    chain_id: int
    market_condition_ids: list[str]
    poll_interval_sec: int
    risk: RiskLimits
    strategy: StrategyParams

    @staticmethod
    def load() -> "Config":
        market_ids_raw = os.getenv("MARKET_CONDITION_IDS", "")
        market_ids = [m.strip() for m in market_ids_raw.split(",") if m.strip()]

        return Config(
            dry_run=_bool("DRY_RUN", True),
            private_key=os.getenv("PRIVATE_KEY", ""),
            poly_api_key=os.getenv("POLY_API_KEY", ""),
            poly_api_secret=os.getenv("POLY_API_SECRET", ""),
            poly_api_passphrase=os.getenv("POLY_API_PASSPHRASE", ""),
            clob_host=os.getenv("CLOB_HOST", "https://clob.polymarket.com"),
            chain_id=_int("CHAIN_ID", 137),
            market_condition_ids=market_ids,
            poll_interval_sec=_int("POLL_INTERVAL_SEC", 15),
            risk=RiskLimits(
                max_position_usd=_float("MAX_POSITION_USD", 500),
                per_market_max_usd=_float("PER_MARKET_MAX_USD", 100),
                max_open_positions=_int("MAX_OPEN_POSITIONS", 5),
                max_daily_loss_usd=_float("MAX_DAILY_LOSS_USD", 100),
                kelly_fraction=_float("KELLY_FRACTION", 0.25),
                max_slippage_cents=_float("MAX_SLIPPAGE_CENTS", 2),
            ),
            strategy=StrategyParams(
                lookback_ticks=_int("LOOKBACK_TICKS", 30),
                z_score_entry=_float("Z_SCORE_ENTRY", 2.0),
                z_score_exit=_float("Z_SCORE_EXIT", 0.5),
            ),
        )

    def require_live_credentials(self) -> None:
        """Call before placing any real order. Fails loudly instead of
        silently trading with an empty/placeholder key."""
        missing = [
            name
            for name, val in (
                ("PRIVATE_KEY", self.private_key),
                ("POLY_API_KEY", self.poly_api_key),
                ("POLY_API_SECRET", self.poly_api_secret),
                ("POLY_API_PASSPHRASE", self.poly_api_passphrase),
            )
            if not val
        ]
        if missing:
            raise RuntimeError(
                f"DRY_RUN=false but missing live credentials: {', '.join(missing)}. "
                "Refusing to trade live without them."
            )
