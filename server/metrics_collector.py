"""Simple in-memory metrics collector with Prometheus-style output.

This is intentionally lightweight to avoid introducing dependencies.
"""
import threading
import time
from typing import Dict

_counters: Dict[str, int] = {}
_gauges: Dict[str, float] = {}
_lock = threading.Lock()


def inc(name: str, amount: int = 1):
    with _lock:
        _counters[name] = _counters.get(name, 0) + amount


def set_gauge(name: str, value: float):
    with _lock:
        _gauges[name] = float(value)


def get_snapshot():
    with _lock:
        return dict(_counters), dict(_gauges)


def as_prometheus_text():
    """Return a simple Prometheus exposition format text."""
    lines = []
    counters, gauges = get_snapshot()
    ts = int(time.time())
    for k, v in counters.items():
        lines.append(f"# TYPE {k} counter")
        lines.append(f"{k} {int(v)} {ts}")
    for k, v in gauges.items():
        lines.append(f"# TYPE {k} gauge")
        lines.append(f"{k} {float(v)} {ts}")
    return "\n".join(lines) + "\n"
