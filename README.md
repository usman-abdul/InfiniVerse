# InfiniVerse

A real-time, multi-user infinite canvas. Join a room via a shareable link and draw, sketch, and build together live — no sign-up required.

Built in ~2 days for the Vega IT Hackathon.

## Features

- **Real-time collaborative drawing** — freehand pen, rectangles, ellipses, triangles, stars, arrows, text, and resizable sticky notes, all synced live between everyone in the room
- **Images & audio** — drop images onto the board, or record and place short audio clips directly on the canvas
- **Infinite pan & zoom** — scroll-wheel or touch pinch-to-zoom, anchored to the cursor/pinch point, plus a one-click Recenter
- **Live presence** — a mini-map shows every collaborator's current viewport, with colored avatar tags and join/leave toasts
- **Offline-first sync** — keep drawing with no internet connection; local changes merge automatically (via a CRDT) the moment you're back online, with no conflicts to resolve
- **Time Travel** — scrub through a full replay of a room's history, from an empty board to its current state, at adjustable speed
- **Physics** — flick a shape to throw it; same-type shapes merge and grow on collision, sticky notes blend colors, and Attract/Repel actions pull or scatter everything in view
- **Export** — the whole board, or a single selected shape, as PNG, SVG, or raw JSON
- Shareable invite links, a mobile-responsive layout, and a reopenable onboarding guide

## Tech stack

| Layer | Stack |
|---|---|
| Frontend | React + Vite, Konva (canvas rendering), Yjs (CRDT sync) |
| Backend | FastAPI (WebSocket relay + REST) |
| Database | PostgreSQL (via async SQLAlchemy) |
| File storage | Local disk, served by FastAPI |
| Deployment | Docker Compose |

Live API docs (Swagger UI) are available at `/docs` once the backend is running.

## Getting started

```bash
cp .env.example .env
docker compose up --build
```

- Backend: `http://localhost:8000` (health check at `/health`)
- Frontend runs separately:

```bash
cd frontend
npm install
npm run dev
```

## Project structure

```
backend/                    # FastAPI + Postgres service
├── Dockerfile                 # Backend container build
├── requirements.txt            # Pinned runtime dependencies
├── test_smoke.py               # In-memory SQLite smoke tests
├── test_rest_smoke.py           # REST endpoint smoke tests
└── app/
    ├── main.py                  # FastAPI entrypoint - CORS, static /uploads mount
    ├── db.py                     # Async SQLAlchemy engine/session setup
    ├── models.py                  # Room + Upload ORM models
    ├── schemas.py                  # Pydantic response schemas
    ├── ws_manager.py                # Per-room connection registry + update history
    └── routers/
        ├── ws.py                      # WS /ws/{room_id} - the realtime relay
        ├── rooms.py                    # Room create/lookup, GET history
        └── uploads.py                   # POST /rooms/{id}/uploads - images + audio

frontend/                   # React + Vite + Konva client
├── index.html
├── vite.config.js
└── src/
    ├── Canvas.jsx                # Main drawing surface - shapes, pan/zoom, render
    ├── useYjsRoom.js              # CRDT sync (Yjs) + IndexedDB offline cache
    ├── usePhysics.js               # Throw / collision / merge physics engine
    ├── TimeTravel.jsx               # Full-history replay modal
    ├── MiniMap.jsx                   # Live viewport overview + peer presence
    ├── StylePanel.jsx                 # Shape properties panel (color, rotation, ...)
    ├── Toolbar.jsx                     # Tool switcher + Shapes/Physics flyouts
    ├── Room.jsx                         # Room screen - header, layout, connection state
    ├── RoomEntry.jsx                     # Join/create room form
    ├── Onboarding.jsx                     # First-visit tips overlay
    ├── Splash.jsx                          # Landing screen with animated starfield
    ├── api.js                               # REST client - rooms, uploads, history
    ├── useHtmlImage.js                       # Image element loader hook for Konva
    └── styles.css                             # Global styles

docs/
└── ENGINEERING_NOTES.md    # Full build log - every part, decision, and bug fix

docker-compose.yml         # Backend + Postgres services for local dev
.env.example               # DATABASE_URL template
```

## Known limitations

These were deliberate scope decisions for a 2-day build, not oversights:

- **No permanent server-side persistence of drawing history.** Room names and uploaded files are saved to Postgres, but the live drawing/update history lives only in the backend process's memory — it's lost on a server restart. (Each browser still keeps its own offline copy via IndexedDB.)
- **No real user accounts.** Joining is guest-mode: a typed username passed to the WebSocket connection, with no password or verification.
- **No undo/redo history** — deletions ask for confirmation instead.
- **Single backend process only** — not built to run as multiple load-balanced instances.
- **Local disk file storage**, not cloud object storage — fine for a demo, not for scale.
- **Physics is client-simulated, not server-authoritative** — if two people throw objects into each other at the same instant, the collision outcome is an approximation rather than one agreed result.

## More detail

This README covers what the app does and how to run it. For the full build log — every part of the build broken down individually, the reasoning behind each design decision, and every bug found and fixed along the way — see [`docs/ENGINEERING_NOTES.md`](docs/ENGINEERING_NOTES.md).

## License

No license has been set yet. Without one, all rights are reserved by default — add a `LICENSE` file (MIT is a common choice for a project like this) if you want others to be able to reuse the code.
