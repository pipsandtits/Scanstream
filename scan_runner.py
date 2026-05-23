"""Centralized scan runner used by Flask and worker processes."""
from datetime import datetime
import asyncio
import logging
import pandas as pd
from typing import List, Dict, Any

from scanner_api import get_scanner, scan_multiple_exchanges_parallel, get_dynamic_config
from workers import task_store

logger = logging.getLogger(__name__)


def run_scan(data: Dict[str, Any], task_id: str = None):
    """Run a scan synchronously (can be called from thread or worker).

    If task_id is provided, persist results to the task store.
    """
    try:
        # Reuse existing logic in scanner_api by calling appropriate functions
        timeframe = data.get('timeframe', 'medium')
        exchange_param = data.get('exchange', 'kucoinfutures')
        full_analysis = data.get('fullAnalysis', True)
        parallel_mode = data.get('parallel', False)

        if isinstance(exchange_param, list):
            exchanges = exchange_param
            parallel_mode = True
        else:
            exchanges = [exchange_param]

        results_summary = {
            'task_started_at': datetime.now().isoformat(),
            'exchanges': exchanges,
            'timeframe': timeframe,
            'full_analysis': full_analysis,
            'signals': [],
            'metadata': {}
        }

        if parallel_mode and len(exchanges) > 1:
            # Run parallel scan via scanner_api helper
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                parallel_result = loop.run_until_complete(
                    scan_multiple_exchanges_parallel(exchanges, timeframe, full_analysis)
                )
            finally:
                loop.close()

            # Aggregate signals
            all_signals = []
            for exchange_id, df in parallel_result['results']:
                if not df.empty:
                    for _, row in df.iterrows():
                        all_signals.append(row.to_dict())

            # Persist full results to training_data/<task_id> files
            result_path = None
            try:
                from pathlib import Path
                out_dir = Path('training_data') / 'scans'
                out_dir.mkdir(parents=True, exist_ok=True)
                if task_id:
                    base = out_dir / f"scan_{task_id}"
                else:
                    base = out_dir / f"scan_{int(datetime.now().timestamp())}"

                df_all = pd.DataFrame(all_signals)
                parquet_path = base.with_suffix('.parquet')
                json_path = base.with_suffix('.json')
                # Write parquet and json
                df_all.to_parquet(parquet_path, compression='gzip')
                df_all.to_json(json_path, orient='records')
                result_path = str(parquet_path)
            except Exception:
                result_path = None

            results_summary['signals'] = []  # do not keep full payload in summary
            results_summary['metadata'] = {'parallel_result': parallel_result, 'result_path': result_path, 'signal_count': len(all_signals)}

        else:
            # Single exchange scan
            exchange = exchanges[0]
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                scanner_instance = get_scanner(loop, exchange)
                results = loop.run_until_complete(
                    scanner_instance.scan_market(timeframe=timeframe, full_analysis=full_analysis, save_results=False)
                )
            finally:
                try:
                    loop.run_until_complete(scanner_instance.exchange.close())
                except Exception:
                    pass
                loop.close()

            if results is not None and not results.empty:
                df_res = pd.DataFrame([row.to_dict() for _, row in results.iterrows()])
                # persist full results
                from pathlib import Path
                out_dir = Path('training_data') / 'scans'
                out_dir.mkdir(parents=True, exist_ok=True)
                if task_id:
                    base = out_dir / f"scan_{task_id}"
                else:
                    base = out_dir / f"scan_{int(datetime.now().timestamp())}"
                parquet_path = base.with_suffix('.parquet')
                json_path = base.with_suffix('.json')
                try:
                    df_res.to_parquet(parquet_path, compression='gzip')
                    df_res.to_json(json_path, orient='records')
                    result_path = str(parquet_path)
                except Exception:
                    result_path = None

                results_summary['signals'] = []
                results_summary['metadata'] = {'signals_found': len(df_res), 'result_path': result_path}

        results_summary['task_completed_at'] = datetime.now().isoformat()

        # Save only metadata to task store; full results are stored on disk
        if task_id:
            metadata = {
                'task_id': task_id,
                'status': 'completed',
                'task_started_at': results_summary.get('task_started_at'),
                'task_completed_at': results_summary.get('task_completed_at'),
                'timeframe': results_summary.get('timeframe'),
                'exchanges': results_summary.get('exchanges'),
                'metadata': results_summary.get('metadata')
            }
            try:
                task_store.save_task(task_id, 'completed', metadata)
            except Exception:
                # best-effort: ignore store failures
                pass

        return results_summary

    except Exception as e:
        logger.exception('Scan runner failed')
        if task_id:
            task_store.save_task(task_id, 'failed', {'error': str(e)})
        raise


def initialize_scanner_sync(exchange_id: str = 'kucoinfutures', task_id: str = None):
    """Initialize scanner resources synchronously and persist status."""
    try:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            # simply attempt to create a scanner to validate initialization
            scanner_instance = get_scanner(loop, exchange_id)
        finally:
            loop.close()

        payload = {'status': 'initialized', 'exchange': exchange_id, 'timestamp': datetime.now().isoformat()}
        if task_id:
            task_store.save_task(task_id, 'completed', payload)
        return payload
    except Exception as e:
        if task_id:
            task_store.save_task(task_id, 'failed', {'error': str(e)})
        raise


def run_train(task_id: str = None):
    """Trigger training run using train_models module."""
    try:
        import train_models
        asyncio.run(train_models.main())
        if task_id:
            task_store.save_task(task_id, 'completed', {'status': 'training_completed', 'timestamp': datetime.now().isoformat()})
        return {'status': 'training_completed'}
    except Exception as e:
        if task_id:
            task_store.save_task(task_id, 'failed', {'error': str(e)})
        raise
