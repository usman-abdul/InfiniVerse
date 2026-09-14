"""
Pydantic models for the JSON control-plane messages sent over the
WebSocket as text frames.

Binary frames on the same socket are raw Yjs protocol bytes (document
updates + awareness/presence) and are never parsed here - they're
opaque to the server and just get relayed. Only these small JSON
messages are things the server (or client) needs to actually read.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel


class UserJoined(BaseModel):
    type: str = "user_joined"
    username: str


class UserLeft(BaseModel):
    type: str = "user_left"
    username: str


class ErrorMessage(BaseModel):
    type: str = "error"
    code: str
    message: str


class RoomState(BaseModel):
    # Sent once, right after a new client connects, listing everyone
    # already in the room (excluding the recipient themselves). Fixes
    # the peer-count bug: existing members learn about new arrivals
    # via UserJoined broadcasts, but a new arrival previously had no
    # way to learn who was already there - they always started at 0.
    type: str = "room_state"
    peers: list[str]


# --- REST schemas (rooms + uploads) ---------------------------------
# Separate from the WS control messages above: these describe the
# JSON bodies for the /rooms REST endpoints, not socket frames.


class RoomCreate(BaseModel):
    name: str | None = None


class RoomOut(BaseModel):
    id: uuid.UUID
    name: str
    created_at: datetime

    model_config = {"from_attributes": True}


class UploadOut(BaseModel):
    id: uuid.UUID
    filename: str
    content_type: str
    size_bytes: int
    url: str
    created_at: datetime

    model_config = {"from_attributes": True}


class RoomHistoryUpdate(BaseModel):
    # Unix timestamp (time.time()) of when the backend recorded this
    # update - gives Time-Travel replay an actual time axis, not just
    # a raw update count.
    t: float
    # Base64-encoded raw Yjs update bytes. Left opaque here for the
    # same reason ws_manager.py never parses these: the server doesn't
    # need to understand a CRDT update to store or forward it, only
    # the frontend's own Y.Doc does.
    data: str


class RoomHistoryOut(BaseModel):
    updates: list[RoomHistoryUpdate]
