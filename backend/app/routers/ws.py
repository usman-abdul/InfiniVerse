"""
WebSocket endpoint: one connection per user, scoped to a room.

Two message "lanes" travel over this same socket:
  - binary frames  -> opaque Yjs Y.Doc update bytes (the shapes map)
  - text frames    -> our own small JSON control messages (join/leave,
    plus a hand-rolled "viewport" presence message - see
    useYjsRoom.js on the frontend). There's no actual Yjs awareness
    protocol in play here; peer viewport/presence is our own message
    type riding the same broadcast path, not awareness bytes.
See schemas.py for the JSON shapes.
"""
from __future__ import annotations

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.schemas import RoomState, UserJoined, UserLeft
from app.ws_manager import room_manager

router = APIRouter()


@router.websocket("/ws/{room_id}")
async def room_socket(websocket: WebSocket, room_id: str, username: str = "Guest") -> None:
    existing_peers = await room_manager.connect(room_id, websocket, username)

    # Tell the new joiner who's already here BEFORE telling everyone
    # else about the new joiner - order matters, otherwise a race
    # could make the count briefly wrong on either side.
    state = RoomState(peers=existing_peers)
    await websocket.send_text(state.model_dump_json())

    # Catch this (re)joining client up on everything that happened in
    # the room before they connected - including while they were
    # offline, if this is a reconnect. Without this, a client's own
    # local Yjs doc (from useYjsRoom.js's full-state send on its own
    # reconnect) is the ONLY way anything ever reaches them again after
    # a drop; anything OTHER peers drew while this client was
    # disconnected would otherwise be invisible until someone draws
    # something new. Safe to replay blindly and in bulk - see
    # ws_manager.py's docstring for why CRDT updates tolerate this.
    for update in room_manager.get_history(room_id):
        await websocket.send_bytes(update)

    joined = UserJoined(username=username)
    await room_manager.broadcast(room_id, websocket, joined.model_dump_json())

    try:
        while True:
            message = await websocket.receive()

            # A disconnect arrives as a message here too (this is the
            # low-level receive() API) - it does NOT raise on its own.
            # Checking the type explicitly avoids calling receive()
            # again after a disconnect, which Starlette forbids.
            if message["type"] == "websocket.disconnect":
                raise WebSocketDisconnect

            if message.get("bytes") is not None:
                # Raw Yjs update or awareness frame - relay live to
                # everyone currently connected, AND remember it so any
                # future (re)joiner can be caught up too.
                room_manager.record_update(room_id, message["bytes"])
                await room_manager.broadcast(room_id, websocket, message["bytes"])

            elif message.get("text") is not None:
                # Our own JSON control messages - relayed for now.
                # Room-level validation (e.g. rejecting a bad join)
                # arrives once REST auth is wired in.
                await room_manager.broadcast(room_id, websocket, message["text"])

    except WebSocketDisconnect:
        was_present = room_manager.disconnect(room_id, websocket)
        if was_present:
            left = UserLeft(username=username)
            await room_manager.broadcast(room_id, websocket, left.model_dump_json())
