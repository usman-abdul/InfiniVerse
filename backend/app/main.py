"""
FastAPI entrypoint for the collaborative canvas backend.

This process holds two things now:
  - the WebSocket relay (app.routers.ws) - live, in-memory, per-room
  - the REST layer (app.routers.rooms/uploads) - Postgres-backed room
    metadata and file uploads

They're currently decoupled: the ws endpoint doesn't check that a
room was REST-created before accepting a connection. See
app/models.py for why that's deliberate for now.
"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.db import init_models
from app.routers import rooms, uploads, ws
from app.routers.uploads import UPLOAD_ROOT

# Needed before StaticFiles mounts below - it errors at import time if
# the directory doesn't exist yet (fresh checkout, no docker volume).
UPLOAD_ROOT.mkdir(exist_ok=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_models()
    yield


app = FastAPI(title="Collaborative Canvas API", lifespan=lifespan)

# Allows the frontend dev server to talk to us. Tighten this before
# any real deployment - "*" is fine for local dev only.
#
# allow_credentials is deliberately False: nothing here uses
# cookie/session auth (rooms are joined by URL alone), and browsers
# reject the combination of allow_origins=["*"] with
# allow_credentials=True outright per the CORS spec - keeping it True
# would silently do nothing today and turn into a real, confusing
# breakage the moment cookie-based auth is added later. Revisit this
# alongside allow_origins once this app is anything other than
# origin-less local dev.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(ws.router)
app.include_router(rooms.router)
app.include_router(uploads.router)
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_ROOT)), name="uploads")


@app.get("/health")
async def health() -> dict[str, str]:
    """Liveness check - useful once this sits behind Docker/a proxy."""
    return {"status": "ok"}
