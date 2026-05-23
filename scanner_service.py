"""Background async service to run ContinuousMultiTimeframeScanner driven by Redis runtime commands.

Usage:
  python scanner_service.py

The service listens for `runtime:continuous_scanner:command` in Redis and updates
`runtime:continuous_scanner:status` with status and stats. The Flask API writes
start/stop commands to the runtime store.
"""
import asyncio
import logging
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
                            try:
                                metrics.inc('status_update_failures')
                            except Exception:
                                pass
    main()
                    # sample metrics periodically
                    try:
                        metrics.sample()
                    except Exception:
                        logger.exception('Metrics sampling failed')
