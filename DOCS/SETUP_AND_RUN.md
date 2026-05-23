# Setup & Run (Development)

Prerequisites
- Node.js 18+ and pnpm installed
- Python 3.10+ and virtualenv
- Git

Quick start (Windows - PowerShell)

1. Clone and enter repo

```powershell
git clone git@github.com:litmajor/Scanstream.git
cd Scanstream
```

2. Python virtualenv (backend workers / ML)

```powershell
python -m venv .venv
. .venv\Scripts\Activate.ps1
pip install -r requirements.txt
pip install -r requirements_worker.txt
```

3. Node dependencies and build (frontend/server TS)

```powershell
pnpm install
pnpm build
```

4. Environment
- Copy `.env.example` -> `.env` and set keys (exchange API keys, DB, redis, etc.)

5. Run services

- Run scanner / server in dev:

```powershell
pnpm start
# or run python workers in separate terminal
python scanner.py
python continuous_scanner.py
```

6. Admin server (kill-switch + metrics)

```powershell
# Start the admin server (needs ts-node or compiled build)
pnpm exec ts-node server/admin-server.ts

# Or run the built JS if you compile the project
node dist/server/admin-server.js
```

6. Tests

```powershell
pnpm test
```

Notes
- Use the `data/kill_switch.json` file (created automatically) to inspect the kill-switch state.
- For production, prefer containerized deployment described in `docs/DEPLOYMENT.md`.
