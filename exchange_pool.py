"""Simple ccxt.async_support exchange pool for reuse across requests.

Provides async get_exchange(exchange_id) and sync wrappers. Maintains one
exchange instance per exchange_id per process and performs load_markets once.
Also provides close_all and close_all_sync for graceful shutdown.
"""
import asyncio
import threading
import os
import logging
from typing import Dict, Optional

import ccxt.async_support as ccxt_async

logger = logging.getLogger(__name__)

_pool: Dict[str, object] = {}
_lock = asyncio.Lock()
_sync_lock = threading.Lock()


async def get_exchange(exchange_id: str = 'kucoinfutures'):
    """Return a shared ccxt exchange instance for the given id (async)."""
    global _pool
    async with _lock:
        if exchange_id in _pool:
            return _pool[exchange_id]

        # Create and initialize
        try:
            exchange_class = getattr(ccxt_async, exchange_id)
        except Exception as e:
            raise RuntimeError(f'Unknown exchange class: {exchange_id}') from e

        exchange = exchange_class({
            'enableRateLimit': True,
            'timeout': int(os.environ.get('EXCHANGE_TIMEOUT_MS', '30000')),
            'options': {'defaultType': 'future', 'recvWindow': 10000}
        })

        try:
            await exchange.load_markets()
        except Exception:
            # still store exchange so callers can attempt usage
            logger.exception('Failed to load markets for %s', exchange_id)

        _pool[exchange_id] = exchange
        return exchange


def get_exchange_sync(exchange_id: str = 'kucoinfutures'):
    """Sync wrapper for get_exchange to be used from sync contexts."""
    loop = None
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop and loop.is_running():
        # We're in an event loop; schedule coroutine
        return asyncio.run_coroutine_threadsafe(get_exchange(exchange_id), loop).result()
    else:
        # Run a temporary loop
        return asyncio.new_event_loop().run_until_complete(get_exchange(exchange_id))


async def close_all():
    """Close all pooled exchanges (async)."""
    global _pool
    async with _lock:
        for k, ex in list(_pool.items()):
            try:
                await ex.close()
            except Exception:
                logger.exception('Error closing exchange %s', k)
            finally:
                _pool.pop(k, None)


def close_all_sync():
    try:
        loop = asyncio.get_event_loop()
    except Exception:
        loop = None

    if loop and loop.is_running():
        # schedule close in running loop
        fut = asyncio.run_coroutine_threadsafe(close_all(), loop)
        try:
            fut.result(timeout=10)
        except Exception:
            pass
    else:
        try:
            asyncio.new_event_loop().run_until_complete(close_all())
        except Exception:
            pass


# Register an atexit-friendly sync close if desired
def register_atexit():
    try:
        import atexit
        atexit.register(close_all_sync)
    except Exception:
        pass


register_atexit()
