from .celery_app import celery_app
from datetime import datetime
import logging

_run_scan_background = None

def _load_runner():
    global _run_scan_background
    if _run_scan_background is None:
        # import lazily to avoid circular imports at module import time
        from scan_runner import run_scan as _runner
        _run_scan_background = _runner
    return _run_scan_background

logger = logging.getLogger(__name__)


@celery_app.task(name='scan.run_scan')
def run_scan_task(data: dict):
    """Celery task wrapper to run scan in worker process."""
    try:
        from celery import current_task
        task_id = None
        try:
            task_id = current_task.request.id
        except Exception:
            task_id = None

        logger.info(f"Celery worker running scan task: {data.get('exchange', 'kucoinfutures')} (task_id={task_id})")
        runner = _load_runner()
        # runner will persist full results and store metadata using task_store
        runner(data, task_id=task_id)
        return {'status': 'completed', 'task_id': task_id, 'timestamp': datetime.now().isoformat()}
    except Exception as e:
        logger.exception('Scan task failed')
        return {'status': 'failed', 'error': str(e), 'timestamp': datetime.now().isoformat()}



@celery_app.task(name='scan.initialize')
def run_initialize_task(data: dict):
    try:
        from celery import current_task
        task_id = None
        try:
            task_id = current_task.request.id
        except Exception:
            task_id = None

        from scan_runner import initialize_scanner_sync
        exchange_id = data.get('exchange', 'kucoinfutures')
        initialize_scanner_sync(exchange_id, task_id=task_id)
        return {'status': 'initialized', 'task_id': task_id}
    except Exception as e:
        logger.exception('Initialize task failed')
        return {'status': 'failed', 'error': str(e)}


@celery_app.task(name='train.run_train')
def run_train_task(data: dict = None):
    try:
        from celery import current_task
        task_id = None
        try:
            task_id = current_task.request.id
        except Exception:
            task_id = None

        from scan_runner import run_train
        run_train(task_id=task_id)
        return {'status': 'training_started', 'task_id': task_id}
    except Exception as e:
        logger.exception('Train task failed')
        return {'status': 'failed', 'error': str(e)}
