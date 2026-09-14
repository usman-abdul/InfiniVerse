"""
REST endpoints for room lifecycle: create a room before anyone
connects to it over the WebSocket, look one up, list recent ones.

This does NOT touch canvas content - that's still relayed live over
/ws/{room_id} and not yet persisted (see ws_manager.py's NOTE). The
one exception is /{room_id}/history below, which reads that same
in-memory relay history directly to power Time-Travel replay - it's
still not Postgres-backed, just exposed over REST instead of only
being used internally on join/reconnect.
"""
from __future__ import annotations

import base64
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import Room
from app.schemas import RoomCreate, RoomHistoryOut, RoomOut
from app.ws_manager import room_manager

router = APIRouter(prefix="/rooms", tags=["rooms"])


@router.post("", response_model=RoomOut, status_code=201)
async def create_room(
    payload: RoomCreate, session: AsyncSession = Depends(get_session)
) -> Room:
    room = Room(name=payload.name or "Untitled room")
    session.add(room)
    await session.commit()
    await session.refresh(room)
    return room


@router.get("/{room_id}", response_model=RoomOut)
async def get_room(room_id: uuid.UUID, session: AsyncSession = Depends(get_session)) -> Room:
    room = await session.get(Room, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    return room


@router.get("", response_model=list[RoomOut])
async def list_rooms(session: AsyncSession = Depends(get_session)) -> list[Room]:
    # Most-recent-first, capped at 50 - this is a "recent rooms" list,
    # not a paginated admin view. Add real pagination if that changes.
    result = await session.execute(select(Room).order_by(Room.created_at.desc()).limit(50))
    return list(result.scalars().all())


@router.get("/{room_id}/history", response_model=RoomHistoryOut)
async def get_room_history(room_id: str) -> dict:
    """
    Every raw Yjs update ever relayed through this room's WebSocket,
    in order, each tagged with when it was recorded - powers
    Time-Travel replay on the frontend (see TimeTravel.jsx, which
    applies these one at a time into a throwaway Y.Doc to reconstruct
    the board's state at any point in the session).

    room_id is a plain str here (not uuid.UUID like the routes above)
    to match exactly how ws.py's WebSocket endpoint keys room_manager -
    both read whatever string arrived in the URL path, unparsed, so
    there's no risk of a UUID-parsing round-trip producing a
    differently-formatted string that misses the room's actual entry.

    Deliberately reads room_manager's in-memory relay history
    directly rather than anything Postgres-backed - same "two
    separate, currently-decoupled things" split as the WS endpoint
    itself (see models.py). No DB session needed, and no 404 for an
    unknown room_id: an empty history for a room nobody's drawn in
    yet and an empty history for a room that never existed look
    identical from here, and "nothing to replay" is the right answer
    either way.
    """
    history = room_manager.get_history_with_timestamps(room_id)
    return {
        "updates": [
            {"t": recorded_at, "data": base64.b64encode(update).decode("ascii")}
            for recorded_at, update in history
        ]
    }
