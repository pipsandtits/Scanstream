"""Background async service to run ContinuousMultiTimeframeScanner driven by Redis runtime commands.

Usage:
  python scanner_service.py

The service listens for `runtime:continuous_scanner:command` in Redis and updates
`runtime:continuous_scanner:status` with status and stats. The Flask API writes
start/stop commands to the runtime store.
"""
import asyncio
import logging
import os
from datetime import datetime
import time

from continuous_scanner import ContinuousMultiTimeframeScanner, StreamConfig
import workers.task_store as task_store

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

POLL_INTERVAL = 1.0


async def run_scanner_loop():
    scanner = None
    scanner_task = None

    while True:
        try:
            cmd = task_store.load_runtime('continuous_scanner:command')
        except Exception:
            cmd = None

        if cmd and isinstance(cmd, dict) and cmd.get('action') == 'start':
            if scanner_task and not scanner_task.done():
                logger.info('Scanner already running; ignoring start command')
            else:
                symbols = cmd.get('symbols', [])
                exchanges = cmd.get('exchanges', [])
                cfg = cmd.get('config') or {}
                try:
                    config = StreamConfig(**cfg) if cfg else StreamConfig()
                except Exception:
                    config = StreamConfig()

                scanner = ContinuousMultiTimeframeScanner(config)

                # persist status
                task_store.save_runtime('continuous_scanner:status', {
                    'running': True,
                    'symbols': symbols,
                    'exchanges': exchanges,
                    'started_at': datetime.now().isoformat(),
                    'timeframes': getattr(config, 'timeframes', [])
                })

                logger.info(f"Starting continuous scanner for {len(symbols)} symbols on exchanges {exchanges}")

                # start scanner in background task
                scanner_task = asyncio.create_task(scanner.start(symbols, exchanges))

        elif cmd and isinstance(cmd, dict) and cmd.get('action') == 'stop':
            if scanner and scanner_task and not scanner_task.done():
                logger.info('Stopping continuous scanner (requested)')
                try:
                    await scanner.stop()
                except Exception:
                    logger.exception('Error while stopping scanner')

                try:
                    # give scanner task a moment to finish
                    await asyncio.wait_for(scanner_task, timeout=10)
                except Exception:
                    scanner_task.cancel()

                task_store.save_runtime('continuous_scanner:status', {'running': False, 'stopped_at': datetime.now().isoformat()})
                # clear the command so repeated stop isn't reprocessed
                task_store.delete_runtime('continuous_scanner:command')
                scanner = None
                scanner_task = None
            else:
                logger.info('No active scanner to stop; clearing command')
                task_store.delete_runtime('continuous_scanner:command')

        # If scanner is running, periodically update status (buffers/signals)
        if scanner and scanner_task and not scanner_task.done():
            try:
                status = {
                    'running': True,
                    'symbols': getattr(scanner, 'symbols', None),
                    'timeframes': getattr(scanner.config, 'timeframes', None),
                    'buffers': {
                        'ticks': len(getattr(scanner, 'tick_buffers', {})),
                        'candles': len(getattr(scanner, 'candle_buffers', {})),
                        'signals': sum(len(s) for s in getattr(scanner, 'signal_history', {}).values())
                    },
                    'updated_at': datetime.now().isoformat()
                }
                task_store.save_runtime('continuous_scanner:status', status)
            except Exception:
                logger.exception('Failed to update scanner status')

        await asyncio.sleep(POLL_INTERVAL)


def main():
    logger.info('Starting scanner_service (listening for runtime commands)')
    try:
        asyncio.run(run_scanner_loop())
    except KeyboardInterrupt:
        logger.info('scanner_service interrupted')


if __name__ == '__main__':
    # Optionally auto-start the continuous scanner via runtime command
    try:
        AUTO_START = os.getenv('SCANNER_AUTO_START', 'true').lower() in ('1', 'true', 'yes')
        if AUTO_START:
            try:
                existing = task_store.load_runtime('continuous_scanner:command')
            except Exception:
                existing = None

            if not existing:
                symbols_env = os.getenv('SCANNER_SYMBOLS')
                if symbols_env:
                    symbols = [s.strip() for s in symbols_env.split(',') if s.strip()]
                else:
                    symbols = [
                        'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT',
                        'ADA/USDT', 'DOGE/USDT', 'MATIC/USDT', 'DOT/USDT', 'LINK/USDT'
                    ]

                exchanges_env = os.getenv('SCANNER_EXCHANGES')
                exchanges = [e.strip() for e in exchanges_env.split(',')] if exchanges_env else ['binance', 'kucoinfutures']

                scan_interval_min = int(os.getenv('SCANNER_SCAN_INTERVAL_MINUTES', '15'))
                cfg = {'scan_interval': scan_interval_min * 60}

                try:
                    task_store.save_runtime('continuous_scanner:command', {
                        'action': 'start',
                        'symbols': symbols,
                        'exchanges': exchanges,
                        'config': cfg
                    })
                    logger.info(f"Auto-start queued continuous scanner (interval {scan_interval_min}m) for {len(symbols)} symbols on {exchanges}")
                except Exception:
                    logger.exception('Failed to queue auto-start command for continuous scanner')
    except Exception:
        logger.exception('Failed while evaluating scanner auto-start')

    main()
