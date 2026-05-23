"""Redis-backed task store for worker task metadata and status."""
import os
import json
from typing import Any, Dict

try:
    import redis
except Exception:
    redis = None

_REDIS_URL = os.environ.get('REDIS_URL') or os.environ.get('CELERY_BROKER_URL') or 'redis://localhost:6379/0'
_client = None


def _get_client():
    global _client
    if _client is None:
        if redis is None:
            raise RuntimeError('redis library not installed')
        # Use a connection pool with sensible defaults
        pool = redis.ConnectionPool.from_url(_REDIS_URL, max_connections=20, socket_timeout=5, decode_responses=True)
        _client = redis.Redis(connection_pool=pool)
    return _client


def _key(task_id: str) -> str:
    return f"task:{task_id}"


def save_task(task_id: str, status: str, payload: Dict[str, Any]):
    """Save task metadata/status to Redis as JSON string."""
    client = _get_client()
    data = {
        'task_id': task_id,
        'status': status,
        'payload': payload
    }
    client.set(_key(task_id), json.dumps(data, default=str))


def load_task(task_id: str) -> Dict[str, Any]:
    client = _get_client()
    raw = client.get(_key(task_id))
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except Exception:
        return {}


def _runtime_key(name: str) -> str:
    return f"runtime:{name}"


def save_runtime(name: str, value: Any):
    """Save arbitrary runtime value (JSON-serializable) under a namespaced runtime key."""
    client = _get_client()
    client.set(_runtime_key(name), json.dumps(value, default=str))


def load_runtime(name: str) -> Any:
    client = _get_client()
    raw = client.get(_runtime_key(name))
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return raw


def delete_runtime(name: str):
    client = _get_client()
    client.delete(_runtime_key(name))
