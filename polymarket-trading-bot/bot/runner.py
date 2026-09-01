"""Main loop: poll markets -> signal -> risk check -> size -> execute.

Run with: python -m bot.runner
"""
from __future__ import annotations

import logging
import time

from bot.config import Config
from bot.executor import Executor, limit_price_with_slippage
from bot.logging_setup import configure_logging
from bot.market_data import MarketDataClient, MarketTokens
from bot.risk import RiskState, check_new_position
from bot.sizing import size_position
from bot.strategy import MeanReversionStrategy, Side

logger = logging.getLogger("polymarket_bot.runner")


def run_once(
    config: Config,
    market_data: MarketDataClient,
    strategy: MeanReversionStrategy,
    risk_state: RiskState,
    executor: Executor,
    token_cache: dict[str, MarketTokens],
) -> None:
    for condition_id in config.market_condition_ids:
        try:
            tokens = token_cache.get(condition_id)
            if tokens is None:
                tokens = market_data.get_market_tokens(condition_id)
                token_cache[condition_id] = tokens

            book = market_data.get_order_book_top(tokens.yes_token_id)
            mid_price = book.mid_price

            signal = strategy.update(condition_id, mid_price)
            if signal.side == Side.FLAT:
                logger.debug("market=%s mid=%.4f z=%.2f -> FLAT", condition_id, mid_price, signal.z_score)
                continue

            decision = check_new_position(
                risk_state, condition_id, config.risk.per_market_max_usd
            )
            if not decision.approved:
                logger.info("market=%s signal=%s REJECTED: %s", condition_id, signal.side, decision.reason)
                continue

            size = size_position(
                confidence=signal.confidence,
                kelly_fraction=config.risk.kelly_fraction,
                available_budget_usd=decision.max_allowed_usd,
                per_market_max_usd=config.risk.per_market_max_usd,
            )
            if size.usd_amount <= 0:
                logger.info("market=%s signal=%s sized to zero: %s", condition_id, signal.side, size.reason)
                continue

            limit_price = limit_price_with_slippage(mid_price, signal.side, config.risk.max_slippage_cents)
            token_id = tokens.yes_token_id if signal.side == Side.BUY_YES else tokens.no_token_id

            result = executor.place_limit_order(token_id, signal.side, size.usd_amount, limit_price)
            logger.info(
                "market=%s signal=%s z=%.2f usd=%.2f limit=%.4f -> %s",
                condition_id, signal.side, signal.z_score, size.usd_amount, limit_price, result.detail,
            )

        except Exception:
            logger.exception("error processing market=%s, skipping this tick", condition_id)


def main() -> None:
    configure_logging()
    config = Config.load()

    if not config.market_condition_ids:
        logger.error("MARKET_CONDITION_IDS is empty in .env — nothing to trade. Exiting.")
        return

    logger.info(
        "starting polymarket bot dry_run=%s markets=%d poll_interval=%ds",
        config.dry_run, len(config.market_condition_ids), config.poll_interval_sec,
    )

    market_data = MarketDataClient(config.clob_host)
    strategy = MeanReversionStrategy(
        lookback_ticks=config.strategy.lookback_ticks,
        z_entry=config.strategy.z_score_entry,
        z_exit=config.strategy.z_score_exit,
    )
    risk_state = RiskState(limits=config.risk)
    executor = Executor(config)
    token_cache: dict[str, MarketTokens] = {}

    while True:
        run_once(config, market_data, strategy, risk_state, executor, token_cache)
        time.sleep(config.poll_interval_sec)


if __name__ == "__main__":
    main()
