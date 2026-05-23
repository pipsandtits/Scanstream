import sqlite3
import json
from pathlib import Path
from datetime import datetime
from typing import Dict, Any, Optional

# DB helper guidance:
# - Prefer parameterized UPSERTs instead of `REPLACE` to avoid delete+insert
#   semantics and unintended trigger/foreign-key side effects.
# - For production workloads prefer Postgres/MySQL with connection pooling.
# - When using an ORM, use `select` to limit fields and prefer single
#   queries with `include` for relations to avoid N+1 patterns. Add simple
#   timing/logging around queries to spot repeated slow calls.

DB_PATH = Path('workers_results.db')


def _get_conn():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = _get_conn()
    try:
        conn.execute('''
            CREATE TABLE IF NOT EXISTS results (
                task_id TEXT PRIMARY KEY,
                status TEXT,
                metadata TEXT,
                result_location TEXT,
                created_at TEXT
            )
        ''')
        conn.commit()
    finally:
        conn.close()


def save_metadata(task_id: str, status: str, metadata: Dict[str, Any], result_location: Optional[str] = None):
    init_db()
    conn = _get_conn()
    try:
        # Use an UPSERT to avoid REPLACE's delete+insert behavior.
        conn.execute(
            '''
            INSERT INTO results (task_id, status, metadata, result_location, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(task_id) DO UPDATE SET
                status = excluded.status,
                metadata = excluded.metadata,
                result_location = excluded.result_location,
                created_at = excluded.created_at
            ''' ,
            (task_id, status, json.dumps(metadata, default=str), result_location or '', datetime.utcnow().isoformat())
        )
        conn.commit()
    finally:
        conn.close()


def get_metadata(task_id: str) -> Dict[str, Any]:
    init_db()
    conn = _get_conn()
    try:
        cur = conn.execute('SELECT * FROM results WHERE task_id = ?', (task_id,))
        row = cur.fetchone()
        if not row:
            return {}
        return {
            'task_id': row['task_id'],
            'status': row['status'],
            'metadata': json.loads(row['metadata']) if row['metadata'] else {},
            'result_location': row['result_location'],
            'created_at': row['created_at']
        }
    finally:
        conn.close()
