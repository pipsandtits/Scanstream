"""FastAPI replacement for scanner API endpoints (parallel to existing Flask app).

This file exposes key endpoints and uses the same worker/task-store/runtime
mechanisms but runs under Uvicorn/ASGI for a single async runtime.
"""
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
import uvicorn
import logging
from datetime import datetime
import threading

from workers.task_store import save_runtime, load_runtime
import workers.task_store as task_store

app = FastAPI()
logger = logging.getLogger(__name__)


@app.get('/health')
async def health():
    return {'status': 'healthy', 'service': 'scanner-api-fastapi', 'timestamp': datetime.now().isoformat()}


@app.post('/api/scanner/scan')
async def trigger_scan(request: Request):
    data = await request.json()
    # determine parallel/exchanges
    exchange_param = data.get('exchange', 'kucoinfutures')
    parallel_mode = data.get('parallel', False)
    if isinstance(exchange_param, list):
        exchanges = exchange_param
        parallel_mode = True
    else:
        exchanges = [exchange_param]

    try:
        from workers.tasks import run_scan_task
        res = run_scan_task.apply_async(args=[data])
        return JSONResponse({'status': 'accepted', 'task_id': res.id}, status_code=202)
    except Exception:
        # fallback: run scan synchronously in background thread
        from scan_runner import run_scan
        t = threading.Thread(target=run_scan, args=(data,), daemon=True)
        t.start()
        return JSONResponse({'status': 'accepted', 'task_id': None, 'note': 'background thread'}, status_code=202)


@app.get('/api/scanner/status')
async def get_status():
    rt_ts = load_runtime('last_scan_timestamp')
    rt_signals = load_runtime('last_scan_signals') or []
    return {
        'status': 'active',
        'last_scan': rt_ts,
        'results_count': len(rt_signals)
    }


@app.post('/api/scanner/continuous/start')
async def start_continuous(body: dict):
    symbols = body.get('symbols', [])
    exchanges = body.get('exchanges', [])
    config = body.get('config', {})
    cmd = {'action': 'start', 'symbols': symbols, 'exchanges': exchanges, 'config': config}
    save_runtime('continuous_scanner:command', cmd)
    return {'status': 'queued'}


@app.post('/api/scanner/continuous/stop')
async def stop_continuous():
    save_runtime('continuous_scanner:command', {'action': 'stop'})
    return {'status': 'queued'}


if __name__ == '__main__':
    uvicorn.run('scanner_api_fastapi:app', host='0.0.0.0', port=5001, reload=False)
