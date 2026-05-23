import threading
import time
import os
import logging

logger = logging.getLogger(__name__)

try:
    import psutil
    PSUTIL_AVAILABLE = True
except Exception:
    PSUTIL_AVAILABLE = False


class MetricsCollector:
    def __init__(self):
        self._lock = threading.Lock()
        self.counters = {}
        self.gauges = {}
        self.last_sample = {}

    def inc(self, name: str, value: int = 1):
        with self._lock:
            self.counters[name] = self.counters.get(name, 0) + value

    def set_gauge(self, name: str, value):
        with self._lock:
            self.gauges[name] = value

    def sample(self):
        """Collect runtime metrics (best-effort)."""
        try:
            pid = os.getpid()
            if PSUTIL_AVAILABLE:
                p = psutil.Process(pid)
                mem = p.memory_info().rss
                cpu = p.cpu_percent(interval=None)
                fds = getattr(p, 'num_fds', lambda: None)()
            else:
                # minimal fallbacks
                mem = None
                cpu = None
                fds = None

            # task count - best-effort (asyncio-specific callers may update)
            ts = time.time()
            with self._lock:
                self.last_sample = {
                    'timestamp': ts,
                    'process_memory_rss': mem,
                    'process_cpu_percent': cpu,
                    'process_fd_count': fds,
                    **self.gauges,
                    **self.counters,
                }

        except Exception:
            logger.exception('Metrics sampling failed')

    def get_metrics(self):
        with self._lock:
            return dict(self.last_sample)


# module-level singleton
collector = MetricsCollector()

def get_collector():
    return collector
