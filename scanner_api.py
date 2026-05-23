"""
Flask API wrapper for the Momentum Scanner
Provides REST endpoints to trigger scans and retrieve results
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import asyncio
import logging
from datetime import datetime
from scanner import MomentumScanner, get_dynamic_config, TechnicalIndicators
from continuous_scanner import ContinuousMultiTimeframeScanner, StreamConfig
import pandas as pd
from typing import Optional, List, Dict
import json
import threading
import ccxt.async_support as ccxt_async
from collections import Counter
from workers.task_store import load_task, save_runtime, load_runtime

# Set up logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Metrics collector
from metrics_collector import get_collector
metrics = get_collector()

# Global uncaught exception hook
def _handle_uncaught_exception(exc_type, exc_value, exc_tb):
    logger.exception('Uncaught exception', exc_info=(exc_type, exc_value, exc_tb))
    try:
        metrics.inc('uncaught_exceptions')
    except Exception:
        pass

import sys
sys.excepthook = _handle_uncaught_exception

# Asyncio loop exception handler
try:
    loop = asyncio.get_event_loop()
    def _loop_exception_handler(loop, context):
        try:
            logger.error('Asyncio loop exception: %s', context)
            metrics.inc('async_loop_exceptions')
        except Exception:
            pass
    loop.set_exception_handler(_loop_exception_handler)
except Exception:
    pass

app = Flask(__name__)
CORS(app)  # Enable CORS for all routes

# Global scanner instances
scanner: Optional[MomentumScanner] = None
continuous_scanner: Optional[ContinuousMultiTimeframeScanner] = None
continuous_scanner_task: Optional[asyncio.Task] = None
continuous_scanner_loop: Optional[asyncio.AbstractEventLoop] = None
last_scan_results: Optional[pd.DataFrame] = None
last_scan_timestamp: Optional[datetime] = None


async def initialize_exchange(exchange_id: str = 'kucoinfutures'):
    """Get exchange from centralized pool."""
    try:
        from exchange_pool import get_exchange
        ex = await get_exchange(exchange_id)
        logger.info(f"Exchange {exchange_id} retrieved from pool")
        return ex
    except Exception as e:
        logger.error(f"Failed to get exchange {exchange_id} from pool: {e}")
        raise


def get_scanner(loop, exchange_id='kucoinfutures'):
    """Create a fresh scanner instance for the given event loop"""
    try:
        # Initialize exchange synchronously with the provided loop (from pool)
        exchange = loop.run_until_complete(initialize_exchange(exchange_id))
        config = get_dynamic_config()
        
        scanner_instance = MomentumScanner(
            exchange=exchange,
            config=config,
            market_type='crypto',
            quote_currency='USDT',
            top_n=50,
            min_volume_usd=100000
        )
        logger.info(f"Scanner instance created successfully for exchange: {exchange_id}")
        return scanner_instance
    except Exception as e:
        logger.error(f"Failed to create scanner for {exchange_id}: {e}")
        raise


async def scan_single_exchange_async(exchange_id: str, timeframe: str, full_analysis: bool = True) -> tuple:
    """
    Scan a single exchange asynchronously
    Returns: (exchange_id, results_df, duration, error)
    """
    start_time = datetime.now()
    
    try:
        logger.info(f"⚡ Starting async scan for {exchange_id}")
        
        # Initialize exchange (from pool)
        init_start = datetime.now()
        exchange = await initialize_exchange(exchange_id)
        init_duration = (datetime.now() - init_start).total_seconds()
        
        # Create scanner
        config = get_dynamic_config()
        scanner_instance = MomentumScanner(
            exchange=exchange,
            config=config,
            market_type='crypto',
            quote_currency='USDT',
            top_n=50,
            min_volume_usd=100000
        )
        
        # Run scan
        scan_start = datetime.now()
        results = await scanner_instance.scan_market(
            timeframe=timeframe,
            full_analysis=full_analysis,
            save_results=False
        )
        scan_duration = (datetime.now() - scan_start).total_seconds()
        
        # Note: Do not close pooled exchange here; pool manages lifecycle
        
        total_duration = (datetime.now() - start_time).total_seconds()
        
        logger.info(f"✅ {exchange_id} scan completed in {total_duration:.2f}s (init: {init_duration:.2f}s, scan: {scan_duration:.2f}s)")
        
        return (exchange_id, results, total_duration, None)
        
    except Exception as e:
        total_duration = (datetime.now() - start_time).total_seconds()
        logger.error(f"❌ {exchange_id} scan failed after {total_duration:.2f}s: {str(e)}")
        return (exchange_id, pd.DataFrame(), total_duration, str(e))


async def scan_multiple_exchanges_parallel(exchanges: List[str], timeframe: str, full_analysis: bool = True) -> Dict:
    """
    Scan multiple exchanges in parallel using asyncio.gather
    
    Args:
        exchanges: List of exchange IDs to scan
        timeframe: Timeframe for scanning
        full_analysis: Whether to run full analysis
        
    Returns:
        Dictionary with aggregated results and metadata
    """
    parallel_start = datetime.now()
    
    logger.info("="*80)
    logger.info(f"🚀 PARALLEL SCAN STARTED")
    logger.info(f"   Exchanges: {', '.join(exchanges)}")
    logger.info(f"   Timeframe: {timeframe}")
    logger.info(f"   Full Analysis: {full_analysis}")
    logger.info(f"   Start Time: {parallel_start.strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]}")
    logger.info("="*80)
    
    # Run all exchanges in parallel (capture exceptions)
    tasks = [scan_single_exchange_async(ex, timeframe, full_analysis) for ex in exchanges]
    results_raw = await asyncio.gather(*tasks, return_exceptions=True)

    # Normalize results and ensure exceptions are logged
    results = []
    for r in results_raw:
        if isinstance(r, Exception):
            logger.exception('Parallel scan task raised exception')
            metrics.inc('parallel_scan_task_exceptions')
            # record a failed placeholder
            results.append((None, pd.DataFrame(), 0.0, str(r)))
        else:
            results.append(r)
    
    parallel_end = datetime.now()
    total_duration = (parallel_end - parallel_start).total_seconds()
    
    # Aggregate results
    all_results = []
    exchange_metadata = {}
    successful_scans = 0
    failed_scans = 0
    
    for exchange_id, df, duration, error in results:
        exchange_metadata[exchange_id] = {
            'duration_seconds': round(duration, 2),
            'success': error is None,
            'error': error,
            'signals_found': len(df) if not df.empty else 0
        }
        
        if error is None:
            successful_scans += 1
            all_results.append((exchange_id, df))
        else:
            failed_scans += 1
    
    # Calculate efficiency gain
    sequential_time = sum(meta['duration_seconds'] for meta in exchange_metadata.values())
    speedup = sequential_time / total_duration if total_duration > 0 else 1
    time_saved = sequential_time - total_duration
    
    logger.info("="*80)
    logger.info(f"✅ PARALLEL SCAN COMPLETED")
    logger.info(f"   Successful: {successful_scans}/{len(exchanges)} exchanges")
    logger.info(f"   Failed: {failed_scans}/{len(exchanges)} exchanges")
    logger.info(f"   Parallel Time: {total_duration:.2f} seconds")
    logger.info(f"   Sequential Time (estimated): {sequential_time:.2f} seconds")
    logger.info(f"   Speedup: {speedup:.2f}x faster")
    logger.info(f"   Time Saved: {time_saved:.2f} seconds ({(time_saved/sequential_time*100):.1f}%)")
    logger.info(f"   End Time: {parallel_end.strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]}")
    logger.info("="*80)
    
    return {
        'results': all_results,
        'exchange_metadata': exchange_metadata,
        'parallel_duration': round(total_duration, 2),
        'sequential_duration_estimated': round(sequential_time, 2),
        'speedup': round(speedup, 2),
        'time_saved': round(time_saved, 2),
        'successful_scans': successful_scans,
        'failed_scans': failed_scans
    }


def format_signal_for_api(row: pd.Series, exchange: str = 'kucoinfutures') -> dict:
    """Format a scanner result row for API response"""
    try:
        # Map signal types to BUY/SELL/HOLD
        signal_mapping = {
            'Strong Buy': 'BUY',
            'Buy': 'BUY',
            'Weak Buy': 'BUY',
            'Strong Sell': 'SELL',
            'Sell': 'SELL',
            'Weak Sell': 'SELL',
            'Neutral': 'HOLD'
        }
        
        signal_type = signal_mapping.get(row.get('signal', 'Neutral'), 'HOLD')
        
        # Calculate price change percentage
        momentum_short = row.get('momentum_short', 0)
        change = momentum_short * 100 if momentum_short else 0
        
        return {
            'id': f"{row.get('symbol', 'UNKNOWN')}_{int(datetime.now().timestamp())}",
            'symbol': row.get('symbol', 'UNKNOWN'),
            'exchange': exchange,
            'timeframe': row.get('timeframe', '1h'),
            'signal': signal_type,
            'strength': min(100, max(0, int(row.get('signal_strength', 50) * 100))),
            'price': float(row.get('price', 0)),
            'change': float(change),
            'volume': float(row.get('volume_usd', 0)),
            'timestamp': row.get('timestamp', datetime.now()).isoformat() if hasattr(row.get('timestamp'), 'isoformat') else datetime.now().isoformat(),
            'indicators': {
                'rsi': float(row.get('rsi', 50)),
                'macd': 'bullish' if row.get('macd', 0) > 0 else 'bearish',
                'ema': 'above' if row.get('ema_5_13_bullish', False) else 'below',
                'volume': 'very_high' if row.get('volume_ratio', 1) > 2 else 'high' if row.get('volume_ratio', 1) > 1.5 else 'medium'
            },
            'advanced': {
                'opportunity_score': float(row.get('opportunity_score', 0)),  # NEW: Best entry point score
                'composite_score': float(row.get('composite_score', 0)),
                'trend_score': float(row.get('trend_score', 0)),
                'confidence_score': float(row.get('confidence_score', 0)),
                'combined_score': float(row.get('combined_score', 0)),  # Overall ranking score
                'ichimoku_bullish': bool(row.get('ichimoku_bullish', False)),
                'vwap_bullish': bool(row.get('vwap_bullish', False)),
                'bb_position': float(row.get('bb_position', 0.5)) if pd.notna(row.get('bb_position')) else 0.5
            },
            'risk_reward': {
                'entry_price': float(row.get('entry_price', row.get('price', 0))),
                'stop_loss': float(row.get('stop_loss', 0)),
                'take_profit': float(row.get('take_profit', 0)),
                'risk_amount': float(row.get('risk_amount', 0)),
                'reward_amount': float(row.get('reward_amount', 0)),
                'risk_reward_ratio': float(row.get('risk_reward_ratio', 0)),
                'stop_loss_pct': float(row.get('stop_loss_pct', 0)),
                'take_profit_pct': float(row.get('take_profit_pct', 0)),
                'support_level': float(row.get('support_level', 0)) if pd.notna(row.get('support_level')) else None,
                'resistance_level': float(row.get('resistance_level', 0)) if pd.notna(row.get('resistance_level')) else None
            },
            'market_regime': {
                'regime': row.get('market_regime', 'unknown'),
                'confidence': float(row.get('regime_confidence', 0)),
                'trend_strength': float(row.get('regime_trend_strength', 0)),
                'volatility': row.get('regime_volatility', 'medium'),
                'suggested_threshold': int(row.get('regime_suggested_threshold', 65))
            }
        }
    except Exception as e:
        logger.error(f"Error formatting signal: {e}")
        return None


@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint"""
    return jsonify({
        'status': 'healthy',
        'service': 'scanner-api',
        'timestamp': datetime.now().isoformat()
    })


@app.route('/metrics', methods=['GET'])
def metrics_endpoint():
    try:
        # ensure latest sample before returning
        try:
            metrics.sample()
        except Exception:
            pass
        data = metrics.get_metrics()
        return jsonify({'metrics': data, 'timestamp': datetime.now().isoformat()})
    except Exception as e:
        logger.exception('Failed to return metrics')
        return jsonify({'error': str(e)}), 500


@app.route('/api/client/error', methods=['POST'])
def client_error():
    try:
        data = request.get_json() or {}
        logger.warning('Client-side error reported: %s', data)
        try:
            metrics.inc('client_errors')
        except Exception:
            pass
        return jsonify({'status': 'ok'}), 200
    except Exception as e:
        logger.exception('Failed to accept client error')
        return jsonify({'error': str(e)}), 500


def _run_scan_background(data):
    # Delegate to centralized scan runner
    try:
        from scan_runner import run_scan
        res = run_scan(data)
        # If running in-process (fallback thread), update in-memory results for quick API access
        try:
            # Persist a small runtime summary (signals list + timestamp) to Redis-backed runtime store
            if res and isinstance(res, dict) and 'signals' in res:
                signals = res.get('signals') or []
                # store signals (list of dicts) and ISO timestamp
                save_runtime('last_scan_signals', signals)
                save_runtime('last_scan_timestamp', datetime.now().isoformat())
        except Exception:
            pass
    except Exception:
        logger.exception('Background scan runner failed')


@app.route('/api/scanner/scan', methods=['POST'])
def trigger_scan():
    """
    Trigger a market scan (single or parallel)
    Returns 202 Accepted immediately - scan runs in background
    Request body:
    {
        "timeframe": "1h" | "4h" | "1d" | "scalping" | "short" | "medium" | "daily",
        "exchange": "binance" | "kucoinfutures" | "coinbase" | "kraken" | ["binance", "okx"],
        "parallel": true | false (default: false, auto-enabled if exchange is array),
        "signal": "all" | "BUY" | "SELL" | "HOLD",
        "minStrength": 0-100,
        "fullAnalysis": true | false
    }
    """
    try:
        data = request.get_json() or {}
        
        # Determine if parallel mode
        exchange_param = data.get('exchange', 'kucoinfutures')
        parallel_mode = data.get('parallel', False)
        
        if isinstance(exchange_param, list):
            exchanges = exchange_param
            parallel_mode = True
        else:
            exchanges = [exchange_param]
        
        if len(exchanges) > 1:
            parallel_mode = True
        
        mode_str = "parallel" if parallel_mode else "single"
        logger.info(f"Scan request queued: {mode_str} mode, exchanges: {exchanges}")
        
        # Enqueue scan job to Celery worker if available, else fallback to background thread
        try:
            from workers.tasks import run_scan_task
            # enqueue and return task id
            res = run_scan_task.apply_async(args=[data])
            task_id = res.id
            logger.info(f"Enqueued scan task to Celery (task_id={task_id})")
            queued_via = 'celery'
        except Exception:
            logger.warning("Celery not available, falling back to background thread")
            scan_thread = threading.Thread(target=_run_scan_background, args=(data,), daemon=True)
            scan_thread.start()
            task_id = None
            queued_via = 'thread'
        
        # Return immediately with 202 Accepted
        return jsonify({
            'status': 'accepted',
            'message': f'Scan queued ({mode_str} mode) via {queued_via}',
            'mode': mode_str,
            'exchanges': exchanges,
            'timeframe': data.get('timeframe', 'medium'),
            'timestamp': datetime.now().isoformat(),
            'task_id': task_id,
            'note': 'Poll /api/scanner/status to check progress. Results will be available in /api/scanner/signals'
        }), 202
        
    except Exception as e:
        logger.error(f"Error queueing scan: {str(e)}", exc_info=True)
        return jsonify({
            'error': str(e),
            'message': 'Failed to queue scan'
        }), 500


@app.route('/api/scanner/signals', methods=['GET'])
def get_signals():
    """
    Get latest scan results with optional filtering
    Query parameters:
    - exchange: filter by exchange
    - timeframe: filter by timeframe
    - signal: filter by signal type (BUY/SELL/HOLD)
    - minStrength: minimum signal strength (0-100)
    """
    global last_scan_results
    
    try:
        # If process-local DataFrame not set, try runtime store (Redis) for last scan summary
        runtime_signals = None
        try:
            runtime_signals = load_runtime('last_scan_signals')
            runtime_timestamp = load_runtime('last_scan_timestamp')
        except Exception:
            runtime_signals = None

        if (last_scan_results is None or (hasattr(last_scan_results, 'empty') and last_scan_results.empty)) and runtime_signals:
            # Return persisted runtime signals
            return jsonify({
                'signals': runtime_signals or [],
                'filters': {
                    'exchanges': ['binance', 'kucoinfutures', 'coinbase', 'kraken'],
                    'timeframes': ['1m', '5m', '15m', '1h', '4h', '1d'],
                    'signals': ['BUY', 'SELL', 'HOLD'],
                    'minStrength': 0,
                    'maxStrength': 100
                },
                'metadata': {
                    'count': len(runtime_signals or []),
                    'last_scan': runtime_timestamp
                }
            })
        
        # Get query parameters
        exchange_filter = request.args.get('exchange', 'all')
        timeframe_filter = request.args.get('timeframe', 'all')
        signal_filter = request.args.get('signal', 'all')
        min_strength = float(request.args.get('minStrength', 0)) / 100
        
        results = last_scan_results.copy()
        
        # Apply filters
        if min_strength > 0:
            results = results[results['signal_strength'] >= min_strength]
        
        if signal_filter != 'all':
            signal_mapping = {
                'BUY': ['Strong Buy', 'Buy', 'Weak Buy'],
                'SELL': ['Strong Sell', 'Sell', 'Weak Sell'],
                'HOLD': ['Neutral']
            }
            if signal_filter in signal_mapping:
                results = results[results['signal'].isin(signal_mapping[signal_filter])]
        
        if timeframe_filter != 'all':
            results = results[results['timeframe'] == timeframe_filter]
        
        # If a task_id is provided, try to load results from task store
        task_id_q = request.args.get('task_id')
        if task_id_q:
            try:
                from workers.task_store import load_task
                task_data = load_task(task_id_q)
                if task_data and task_data.get('status') == 'completed':
                    return jsonify({
                        'signals': task_data['payload'].get('signals', []),
                        'filters': {
                            'exchanges': ['binance', 'kucoinfutures', 'coinbase', 'kraken'],
                            'timeframes': ['1m', '5m', '15m', '1h', '4h', '1d'],
                            'signals': ['BUY', 'SELL', 'HOLD'],
                            'minStrength': 0,
                            'maxStrength': 100
                        },
                        'metadata': {
                            'count': len(task_data['payload'].get('signals', [])),
                            'task_id': task_id_q,
                            'task_status': task_data.get('status')
                        }
                    })
            except Exception:
                pass

        # Format results
        signals = []
        for _, row in results.iterrows():
            formatted = format_signal_for_api(row, exchange_filter if exchange_filter != 'all' else 'kucoinfutures')
            if formatted:
                signals.append(formatted)
        
        return jsonify({
            'signals': signals,
            'filters': {
                'exchanges': ['binance', 'kucoinfutures', 'coinbase', 'kraken'],
                'timeframes': ['1m', '5m', '15m', '1h', '4h', '1d'],
                'signals': ['BUY', 'SELL', 'HOLD'],
                'minStrength': 0,
                'maxStrength': 100
            },
            'metadata': {
                'count': len(signals),
                'last_scan': last_scan_timestamp.isoformat() if last_scan_timestamp else None
            }
        })
        
    except Exception as e:
        logger.error(f"Error retrieving signals: {str(e)}", exc_info=True)
        return jsonify({
            'error': str(e),
            'message': 'Failed to retrieve signals'
        }), 500


@app.route('/api/scanner/status', methods=['GET'])
def get_status():
    """Get scanner status and statistics"""
    global scanner
    is_initialized = scanner is not None
    is_active = is_initialized  # Only active if properly initialized
    # Prefer runtime persisted last-scan metadata when available
    try:
        rt_ts = load_runtime('last_scan_timestamp')
        rt_signals = load_runtime('last_scan_signals') or []
    except Exception:
        rt_ts = None
        rt_signals = []

    return jsonify({
        'status': 'active' if is_active else 'inactive',
        'scanner_initialized': is_initialized,
        'last_scan': rt_ts or (last_scan_timestamp.isoformat() if last_scan_timestamp else None),
        'results_count': len(rt_signals) if rt_signals is not None else (len(last_scan_results) if last_scan_results is not None else 0),
        'timestamp': datetime.now().isoformat()
    })


def _initialize_scanner_background(exchange_id):
    """
    Background thread function to initialize scanner
    """
    global scanner
    
    try:
        logger.info(f"Background init starting for exchange: {exchange_id}")
        
        # Create event loop and initialize scanner
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        try:
            scanner = get_scanner(loop, exchange_id)
            logger.info(f"✅ Scanner initialized successfully for {exchange_id} (background)")
        finally:
            loop.close()
            
    except Exception as e:
        logger.error(f"❌ Error initializing scanner in background: {str(e)}", exc_info=True)


@app.route('/api/scanner/initialize', methods=['POST'])
def initialize_scanner():
    """Initialize the scanner with a specific exchange (non-blocking)"""
    global scanner
    
    try:
        data = request.get_json() or {}
        exchange_id = data.get('exchange', 'kucoinfutures')
        
        if scanner is not None:
            logger.info(f"Scanner already initialized for exchange: {exchange_id}")
            return jsonify({
                'status': 'already_initialized',
                'message': f'Scanner is already initialized',
                'exchange': exchange_id,
                'timestamp': datetime.now().isoformat()
            }), 200
        
        logger.info(f"Queueing scanner initialization for exchange: {exchange_id}")
        try:
            from workers.tasks import run_initialize_task
            res = run_initialize_task.apply_async(args=[{'exchange': exchange_id}])
            task_id = res.id
            queued_via = 'celery'
            logger.info(f"Enqueued initialize task (task_id={task_id})")
        except Exception:
            # Fallback: run in background thread
            init_thread = threading.Thread(target=_initialize_scanner_background, args=(exchange_id,), daemon=True)
            init_thread.start()
            task_id = None
            queued_via = 'thread'

        return jsonify({
            'status': 'accepted',
            'message': f'Scanner initialization queued for {exchange_id} via {queued_via}',
            'exchange': exchange_id,
            'task_id': task_id,
            'timestamp': datetime.now().isoformat(),
            'note': 'Poll /api/scanner/status to check when scanner_initialized is true'
        }), 202
            
    except Exception as e:
        logger.error(f"Error queueing scanner initialization: {str(e)}", exc_info=True)
        return jsonify({
            'error': str(e),
            'message': 'Failed to queue scanner initialization'
        }), 500


@app.route('/api/scanner/reset', methods=['POST'])
def reset_scanner():
    """Reset scanner state (clears current instance)"""
    global scanner, last_scan_results, last_scan_timestamp
    
    try:
        if scanner:
            # Close exchange connection if needed
            if hasattr(scanner, 'exchange') and hasattr(scanner.exchange, 'close'):
                try:
                    asyncio.run(scanner.exchange.close())
                except:
                    pass
        # Clear process-local and runtime persisted state
        scanner = None
        last_scan_results = None
        last_scan_timestamp = None
        try:
            from workers.task_store import delete_runtime
            delete_runtime('last_scan_signals')
            delete_runtime('last_scan_timestamp')
        except Exception:
            pass
        
        logger.info("Scanner reset successfully")
        
        return jsonify({
            'status': 'reset',
            'message': 'Scanner has been reset',
            'timestamp': datetime.now().isoformat()
        })
        
    except Exception as e:
        logger.error(f"Error resetting scanner: {str(e)}", exc_info=True)
        return jsonify({
            'error': str(e),
            'message': 'Failed to reset scanner'
        }), 500


@app.route('/api/train/models', methods=['POST'])
def trigger_training():
    """Enqueue a model training job (non-blocking)."""
    try:
        data = request.get_json() or {}
        try:
            from workers.tasks import run_train_task
            res = run_train_task.apply_async(args=[data])
            task_id = res.id
            queued_via = 'celery'
        except Exception:
            # Fallback: run training in background thread (not ideal)
            import threading
            from scan_runner import run_train
            t = threading.Thread(target=run_train, args=(None,), daemon=True)
            t.start()
            task_id = None
            queued_via = 'thread'

        return jsonify({
            'status': 'accepted',
            'message': f'Training job queued via {queued_via}',
            'task_id': task_id,
            'timestamp': datetime.now().isoformat()
        }), 202
    except Exception as e:
        logger.error(f"Error queueing training job: {str(e)}", exc_info=True)
        return jsonify({'error': str(e), 'message': 'Failed to queue training job'}), 500


@app.route('/api/scanner/multi-timeframe', methods=['POST'])
def multi_timeframe_confluence():
    """
    Scan multiple timeframes and find confluence opportunities
    Request body:
    {
        "symbol": "BTC/USDT",
        "timeframes": ["1h", "4h", "1d"],
        "minOpportunity": 65
    }
    """
    try:
        data = request.get_json() or {}
        symbol = data.get('symbol', 'BTC/USDT')
        timeframes = data.get('timeframes', ['short', 'medium', 'daily'])
        min_opportunity = data.get('minOpportunity', 65)
        
        logger.info(f"Multi-timeframe analysis for {symbol}: {timeframes}")

        def normalize_symbol(s: str) -> str:
            if not s:
                return ''
            return s.upper().replace('-', '/').replace('\\\u002F\\\u002F', '/').strip()

        norm_symbol = normalize_symbol(symbol)

        # Create scanner instance bound to a new loop
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        exchange_id = data.get('exchange', 'kucoinfutures')
        try:
            scanner_instance = get_scanner(loop, exchange_id=exchange_id)
        except Exception as e:
            loop.close()
            logger.error(f"Failed to create scanner for multi-timeframe: {e}")
            return jsonify({'error': 'Failed to initialize scanner', 'message': str(e)}), 500

        try:
            # Prepare coroutines for each timeframe
            coros = [scanner_instance.scan_market(timeframe=tf, full_analysis=True, save_results=False) for tf in timeframes]

            # Run all timeframe scans in parallel with a timeout and isolate errors per timeframe
            try:
                results_list = loop.run_until_complete(asyncio.wait_for(asyncio.gather(*coros, return_exceptions=True), timeout=30))
            except asyncio.TimeoutError:
                # Partial results may be available; collect what finished
                results_list = loop.run_until_complete(asyncio.gather(*coros, return_exceptions=True))

            all_results = []
            errors = []

            for idx, res in enumerate(results_list):
                tf = timeframes[idx]
                if isinstance(res, Exception):
                    logger.warning(f"Timeframe {tf} scan failed: {res}")
                    errors.append({'timeframe': tf, 'error': str(res)})
                    continue

                df = res
                if df is None or df.empty:
                    logger.info(f"No data for timeframe {tf}")
                    continue

                # Normalize symbols in df for robust matching
                try:
                    df = df.copy()
                    df['__norm_symbol'] = df['symbol'].astype(str).apply(normalize_symbol)
                except Exception:
                    # If symbol column missing or other issue, skip this timeframe
                    logger.warning(f"Skipping timeframe {tf} due to invalid result format")
                    continue

                matched = df[df['__norm_symbol'] == norm_symbol]
                if matched.empty:
                    # try relaxed match by replacing '/' with '' etc
                    matched = df[df['__norm_symbol'] == norm_symbol.replace('/', '')]

                if matched.empty:
                    logger.info(f"Symbol {symbol} not found in timeframe {tf}")
                    continue

                row = matched.iloc[0].to_dict()
                all_results.append({'timeframe': tf, 'data': row})

        finally:
            # Attempt to close exchange connection held by scanner_instance
            try:
                if 'scanner_instance' in locals() and hasattr(scanner_instance, 'exchange') and hasattr(scanner_instance.exchange, 'close'):
                    try:
                        loop.run_until_complete(scanner_instance.exchange.close())
                    except Exception:
                        pass
            except Exception:
                pass
            loop.close()

        if not all_results:
            return jsonify({
                'symbol': symbol,
                'confluence': False,
                'message': f'No data found for {symbol} across timeframes',
                'timeframes_analyzed': timeframes,
                'errors': errors
            })

        # Collect scores, signals, regimes
        opportunity_scores = [r['data'].get('opportunity_score', 0) for r in all_results]
        signals = [r['data'].get('signal', 'Neutral') for r in all_results]
        regimes = [r['data'].get('market_regime', 'unknown') for r in all_results]

        # Weighted scoring: give more weight to larger timeframes (later in list)
        n = len(all_results)
        # Determine weights based on original timeframes order: larger index -> more weight
        weights = []
        for i in range(n):
            weights.append(i + 1)
        total = sum(weights)
        weights = [w / total for w in weights]

        # align weights to the order of all_results (which follows timeframes order)
        weighted_score = sum(score * weights[idx] for idx, score in enumerate(opportunity_scores))

        # Direction counts
        bullish_set = set(['Strong Buy', 'Buy', 'Weak Buy'])
        bearish_set = set(['Strong Sell', 'Sell', 'Weak Sell'])
        bullish_count = sum(1 for s in signals if s in bullish_set)
        bearish_count = sum(1 for s in signals if s in bearish_set)

        # Majority directional alignment: require dominant direction > half of timeframes
        dominant_direction = 'NEUTRAL'
        if bullish_count > bearish_count and bullish_count > (n / 2):
            dominant_direction = 'BULLISH'
        elif bearish_count > bullish_count and bearish_count > (n / 2):
            dominant_direction = 'BEARISH'

        # Use Counter to determine dominant regime safely
        dominant_regime = Counter(regimes).most_common(1)[0][0] if regimes else 'unknown'

        # Determine confluence: require majority alignment and weighted score threshold
        has_confluence = (dominant_direction in ('BULLISH', 'BEARISH')) and (weighted_score >= min_opportunity)

        avg_opportunity = sum(opportunity_scores) / len(opportunity_scores) if opportunity_scores else 0

        return jsonify({
            'symbol': symbol,
            'confluence': has_confluence,
            'dominant_direction': dominant_direction,
            'weighted_score': round(weighted_score, 2),
            'timeframes_analyzed': len(all_results),
            'average_opportunity': round(avg_opportunity, 2),
            'bullish_timeframes': bullish_count,
            'bearish_timeframes': bearish_count,
            'dominant_regime': dominant_regime,
            'timeframe_results': [
                {
                    'timeframe': r['timeframe'],
                    'signal': r['data'].get('signal', 'Neutral'),
                    'opportunity_score': r['data'].get('opportunity_score', 0),
                    'market_regime': r['data'].get('market_regime', 'unknown'),
                    'price': r['data'].get('price', 0),
                    'rsi': r['data'].get('rsi', 50)
                }
                for r in all_results
            ],
            'errors': errors,
            'recommendation': 'STRONG' if has_confluence and weighted_score > 75 else 'MODERATE' if has_confluence else 'WEAK'
        })
        
    except Exception as e:
        logger.error(f"Error in multi-timeframe analysis: {str(e)}", exc_info=True)
        return jsonify({
            'error': str(e),
            'message': 'Failed to complete multi-timeframe analysis'
        }), 500



@app.route('/api/position/calculate', methods=['POST'])
def calculate_position():
    """
    Calculate position size based on account and risk parameters
    Request body:
    {
        "accountBalance": 10000,
        "riskPerTrade": 2,
        "entryPrice": 45000,
        "stopLoss": 43000,
        "leverage": 1,
        "feeRate": 0.001
    }
    """
    try:
        data = request.get_json() or {}
        
        account_balance = float(data.get('accountBalance', 10000))
        risk_per_trade = float(data.get('riskPerTrade', 2))
        entry_price = float(data.get('entryPrice', 0))
        stop_loss = float(data.get('stopLoss', 0))
        leverage = float(data.get('leverage', 1))
        fee_rate = float(data.get('feeRate', 0.001))
        
        if entry_price <= 0 or stop_loss <= 0:
            return jsonify({'error': 'Invalid entry price or stop loss'}), 400
        
        position_calc = TechnicalIndicators.calculate_position_size(
            account_balance=account_balance,
            risk_per_trade_pct=risk_per_trade,
            entry_price=entry_price,
            stop_loss=stop_loss,
            leverage=leverage,
            fee_rate=fee_rate
        )
        
        return jsonify(position_calc)
        
    except Exception as e:
        logger.error(f"Error calculating position: {str(e)}", exc_info=True)
        return jsonify({
            'error': str(e),
            'message': 'Failed to calculate position size'
        }), 500


@app.route('/api/scanner/continuous/start', methods=['POST'])
def start_continuous_scanner():
    """
    Start continuous multi-timeframe scanner
    Request body:
    {
        "symbols": ["BTC/USDT", "ETH/USDT", ...],
        "exchanges": ["binance", "kucoinfutures"],
        "config": {optional config overrides}
    }
    """
    global continuous_scanner, continuous_scanner_task, continuous_scanner_loop
    
    try:
        if continuous_scanner and continuous_scanner.running:
            return jsonify({
                'status': 'already_running',
                'message': 'Continuous scanner is already running'
            })
        
        data = request.get_json() or {}
        symbols = data.get('symbols', [
            'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT',
            'ADA/USDT', 'DOGE/USDT', 'MATIC/USDT', 'DOT/USDT', 'LINK/USDT'
        ])
        exchanges = data.get('exchanges', ['binance', 'kucoinfutures'])
        config_dict = data.get('config', {})
        
        # Persist start command into runtime store; a separate `scanner_service.py` should pick this up
        cmd = {
            'action': 'start',
            'symbols': symbols,
            'exchanges': exchanges,
            'config': config_dict
        }
        try:
            save_runtime('continuous_scanner:command', cmd)
            logger.info(f"Queued continuous scanner start command for {len(symbols)} symbols")
            return jsonify({
                'status': 'queued',
                'symbols': symbols,
                'exchanges': exchanges,
                'message': 'Continuous scanner start queued (external service should handle)'
            })
        except Exception as e:
            logger.error(f"Failed to queue continuous scanner start: {e}", exc_info=True)
            return jsonify({'error': str(e), 'message': 'Failed to queue continuous scanner start'}), 500
        
    except Exception as e:
        logger.error(f"Error starting continuous scanner: {str(e)}", exc_info=True)
        return jsonify({
            'error': str(e),
            'message': 'Failed to start continuous scanner'
        }), 500


@app.route('/api/scanner/continuous/stop', methods=['POST'])
def stop_continuous_scanner():
    """Stop continuous scanner"""
    global continuous_scanner, continuous_scanner_task, continuous_scanner_loop
    
    try:
        if not continuous_scanner or not continuous_scanner.running:
            return jsonify({
                'status': 'not_running',
                'message': 'Continuous scanner is not running'
            })
        
        # Signal external scanner service to stop
        try:
            save_runtime('continuous_scanner:command', {'action': 'stop'})
            logger.info('Queued continuous scanner stop command')
            return jsonify({'status': 'queued', 'message': 'Stop command queued for continuous scanner'})
        except Exception as e:
            logger.error(f"Failed to queue stop command: {e}", exc_info=True)
            return jsonify({'error': str(e), 'message': 'Failed to queue stop command'}), 500
        
    except Exception as e:
        logger.error(f"Error stopping continuous scanner: {str(e)}", exc_info=True)
        return jsonify({
            'error': str(e),
            'message': 'Failed to stop continuous scanner'
        }), 500


@app.route('/api/scanner/continuous/status', methods=['GET'])
def continuous_scanner_status():
    """Get continuous scanner status"""
    global continuous_scanner
    
    try:
        # Read status from runtime store (populated by external scanner service)
        status = load_runtime('continuous_scanner:status') or {}
        if not status:
            return jsonify({'running': False, 'message': 'Scanner service not responding or not started'})
        return jsonify(status)
        
    except Exception as e:
        logger.error(f"Error getting continuous scanner status: {str(e)}", exc_info=True)
        return jsonify({
            'error': str(e),
            'message': 'Failed to get scanner status'
        }), 500


@app.route('/api/scanner/continuous/signals', methods=['GET'])
def get_continuous_signals():
    """
    Get latest signals from continuous scanner
    Query params:
    - symbol: Filter by symbol (optional)
    - timeframe: Filter by timeframe (optional)
    - min_score: Minimum combined score (default 0)
    - limit: Max results (default 50)
    """
    global continuous_scanner
    
    try:
        if not continuous_scanner:
            return jsonify({
                'error': 'Scanner not running',
                'signals': []
            }), 503
        
        symbol = request.args.get('symbol')
        timeframe = request.args.get('timeframe')
        min_score = float(request.args.get('min_score', 0))
        limit = int(request.args.get('limit', 50))
        
        signals = continuous_scanner.get_latest_signals(
            symbol=symbol,
            timeframe=timeframe,
            min_score=min_score,
            limit=limit
        )
        
        return jsonify({
            'signals': signals,
            'count': len(signals),
            'timestamp': datetime.now().isoformat()
        })
        
    except Exception as e:
        logger.error(f"Error getting continuous signals: {str(e)}", exc_info=True)
        return jsonify({
            'error': str(e),
            'message': 'Failed to get continuous signals'
        }), 500


@app.route('/api/scanner/continuous/confluence/<symbol>', methods=['GET'])
def get_continuous_confluence(symbol: str):
    """
    Get multi-timeframe confluence for a symbol
    Path param: symbol (e.g., BTC/USDT)
    Query params:
    - min_score: Minimum score threshold (default 60)
    """
    global continuous_scanner
    
    try:
        if not continuous_scanner:
            return jsonify({
                'error': 'Scanner not running'
            }), 503
        
        min_score = float(request.args.get('min_score', 60))
        
        # Run async function in scanner's event loop
        if continuous_scanner_loop:
            future = asyncio.run_coroutine_threadsafe(
                continuous_scanner.get_multi_timeframe_confluence(symbol, min_score),
                continuous_scanner_loop
            )
            result = future.result(timeout=10)
        else:
            result = {'error': 'Scanner loop not available'}
        
        return jsonify(result)
        
    except Exception as e:
        logger.error(f"Error getting confluence for {symbol}: {str(e)}", exc_info=True)
        return jsonify({
            'error': str(e),
            'message': 'Failed to get multi-timeframe confluence'
        }), 500


@app.route('/api/scanner/continuous/market-state', methods=['GET'])
def get_market_state():
    """Get current global market state"""
    global continuous_scanner
    
    try:
        if not continuous_scanner:
            return jsonify({
                'error': 'Scanner not running'
            }), 503
        
        market_state = continuous_scanner.get_market_state()
        
        return jsonify({
            'market_state': market_state,
            'timestamp': datetime.now().isoformat()
        })
        
    except Exception as e:
        logger.error(f"Error getting market state: {str(e)}", exc_info=True)
        return jsonify({
            'error': str(e),
            'message': 'Failed to get market state'
        }), 500


@app.route('/api/scanner/training-data/<symbol>', methods=['GET'])
def get_training_data(symbol: str):
    """
    Get training dataset for Oracle Engine & RL pipeline
    Path param: symbol (e.g., BTC/USDT)
    Query params:
    - days: Number of days of historical data (default 30)
    """
    global continuous_scanner
    
    try:
        if not continuous_scanner:
            return jsonify({
                'error': 'Scanner not running'
            }), 503
        
        days = int(request.args.get('days', 30))
        
        # Run async function
        if continuous_scanner_loop:
            future = asyncio.run_coroutine_threadsafe(
                continuous_scanner.persistence.get_training_dataset(symbol, days),
                continuous_scanner_loop
            )
            dataset = future.result(timeout=30)
        else:
            dataset = {'error': 'Scanner loop not available'}
        
        return jsonify({
            'symbol': symbol,
            'days': days,
            'dataset': dataset,
            'summary': {
                'total_signals': len(dataset.get('signals', [])),
                'timeframes': list(dataset.get('ohlcv', {}).keys()),
                'total_clusters': len(dataset.get('clustering', []))
            }
        })
        
    except Exception as e:
        logger.error(f"Error getting training data for {symbol}: {str(e)}", exc_info=True)
        return jsonify({
            'error': str(e),
            'message': 'Failed to get training data'
        }), 500


if __name__ == '__main__':
    logger.info("Starting Scanner API on port 5001")
    logger.info("Continuous scanner endpoints available:")
    logger.info("  POST /api/scanner/continuous/start")
    logger.info("  POST /api/scanner/continuous/stop")
    logger.info("  GET  /api/scanner/continuous/status")
    logger.info("  GET  /api/scanner/continuous/signals")
    logger.info("  GET  /api/scanner/continuous/confluence/<symbol>")
    logger.info("  GET  /api/scanner/continuous/market-state")
    logger.info("  GET  /api/scanner/training-data/<symbol>")
    app.run(host='0.0.0.0', port=5001, debug=False)

