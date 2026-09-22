# AI Employer

Cross-platform desktop app (Electron + React + FastAPI) for managing an autonomous AI
workforce — multiple agents running concurrent tasks through **one shared Claude API
key**, centrally rate-limited and budget-tracked.

## Stack

| Layer | Tech |
|---|---|
| Desktop shell | Electron 31 (main + preload, TypeScript) |
| Renderer | React 18 + Vite + TypeScript + Tailwind + Zustand |
| Orchestrator | FastAPI (Python 3.11+), SSE streaming |
| Model access | `anthropic` SDK → `claude-opus-5`, prompt-cached, token-bucket limited |
| Persistence | SQLite via SQLAlchemy async |

## Setup

```powershell
# 1. Frontend deps
npm install

# 2. Python venv + backend deps
python -m venv .venv
.venv\Scripts\pip install -r backend/requirements.txt

# 3. API key
copy .env.example .env      # then edit: ANTHROPIC_API_KEY=sk-ant-...
```

### Run (dev)

```powershell
# Terminal 1 — backend
.venv\Scripts\python -m uvicorn backend.main:app --host 127.0.0.1 --port 8737

# Terminal 2 — desktop app (Vite + Electron)
npm run dev
```

The Electron main process spawns the sidecar itself when launched standalone
(`electron .`); `npm run dev` assumes you started the backend manually and
waits on port 8737 either way.

### Production build

```powershell
# Bundle the backend into a standalone exe
npm run backend:binary

# Build + package the desktop app (expects backend/dist/aiemployer-server.exe)
npm run dist
```

## Architecture

```
muticoop/
├── electron/            # main.ts (sidecar spawner + IPC), preload.ts
├── src/                 # React renderer
│   ├── components/      # Dashboard, TaskBoard, AgentStudio, AgentTerminal
│   └── lib/             # api client, zustand store, SSE hook
├── backend/
│   ├── main.py          # FastAPI routes, SSE hub, approval gate
│   ├── rate_limiter.py  # token buckets (RPM/ITPM/OTPM) + dispatch queue
│   ├── agent_runner.py  # Anthropic wrapper: caching, streaming, backoff, tool loop
│   ├── tools.py         # pluggable tools (path-sandboxed; terminal needs approval)
│   └── db.py            # SQLAlchemy async models
└── data/                # runtime: SQLite DB + agent workspace
```

### How a task flows

1. **TaskBoard** → `POST /api/tasks` then `POST /api/tasks/{id}/dispatch`.
2. The **Orchestrator** enqueues a `RunRequest`; a worker acquires
   RPM + ITPM + OTPM bucket reservations (estimates refunded against real
   usage after the run).
3. **`agent_runner.run_agent`** streams each turn
   (`thinking_delta` / `text_delta` / `tool_input_delta`), honoring
   `retry-after` on 429 and full backoff on 529/5xx/network errors.
4. Tool calls execute sandboxed inside `data/workspace`; `terminal` is
   elevated → the runner raises an approval request → the **Dashboard** shows
   Approve/Deny → `POST /api/tasks/{id}/approve` resolves the pending future.
5. Events persist to SQLite (replayable) and fan out over
   `GET /api/tasks/{id}/stream` (SSE) to the Live Agent Terminal.

### Prompt caching

The runner freezes a shared system prefix (platform rules) with
`cache_control: {"type": "ephemeral"}`; per-agent personas and task payloads
are appended **after** the breakpoint so they never invalidate it. Check
`turn_usage` events — `cache_read` should grow turn over turn while
`cache_write` stays small.