from celery import Celery
import os

# Configure Celery broker via env or default to redis://localhost:6379/0
BROKER = os.environ.get('CELERY_BROKER_URL', 'redis://localhost:6379/0')
BACKEND = os.environ.get('CELERY_RESULT_BACKEND', BROKER)

celery_app = Celery('scan_tasks', broker=BROKER, backend=BACKEND)

# Optional: configure some defaults
celery_app.conf.update(result_expires=3600, task_acks_late=True)
