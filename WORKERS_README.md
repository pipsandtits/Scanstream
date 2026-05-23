# Worker setup and run instructions

This project includes a small Python worker package using Celery to run heavy tasks (scans, initialization, training) outside the Flask process.

Prerequisites
- Python virtual environment with project dependencies installed.
- Redis (or another Celery broker) available and reachable.

Install worker dependencies (from repo root):

```bash
python -m pip install -r requirements_worker.txt
```

Environment variables
- `REDIS_URL` or `CELERY_BROKER_URL`: broker URL (default: `redis://localhost:6379/0`)

Start a Celery worker

```bash
# from repo root
celery -A workers.celery_app.celery_app worker --loglevel=info
```

Example API usage (Flask server must be running)

- Trigger a scan (returns `task_id`):

```bash
curl -X POST http://localhost:5000/api/scanner/scan \
  -H 'Content-Type: application/json' \
  -d '{"exchange": ["kucoinfutures", "binance"], "timeframe": "1h", "parallel": true}'
```

- Poll for results by `task_id` (returns metadata with `result_path`):

```bash
curl "http://localhost:5000/api/scanner/signals?task_id=<TASK_ID>"
```

- Initialize scanner (enqueue):

```bash
curl -X POST http://localhost:5000/api/scanner/initialize -H 'Content-Type: application/json' -d '{"exchange": "kucoinfutures"}'
```

- Trigger training (enqueue):

```bash
curl -X POST http://localhost:5000/api/train/models -H 'Content-Type: application/json' -d '{}'
```

Notes
- Full scan results are written to `training_data/scans/scan_<task_id>.parquet` (and a JSON copy). The Flask endpoint returns only task metadata; use the `task_id` to fetch the persisted files.
- For production, configure a Redis instance for `REDIS_URL`. Consider securing access to Redis and enabling persistence as needed.
