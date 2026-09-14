"""
In-memory room connection registry.

Each room maps connected WebSockets to the username they joined with.
This is intentionally simple for the MVP: one FastAPI process, one
dict, no Redis - fine at this scale since we're only ever running a
single backend instance (see architecture notes for when that stops
being true).

Also keeps a per-room history of every raw Yjs update byte-string ever
relayed through this room (each tagged with the wall-clock time it was
recorded), and replays it to each new/reconnecting client. This does
NOT require actually parsing or merging Yjs documents server-side (no
pycrdt dependency needed) - Yjs updates are CRDT operations, so
applying the same one twice, or out of order, is always safe on the
receiving client; "replay everything ever sent" is enough to guarantee
a (re)joining client ends up with the same state as everyone else,
without the server needing to understand what's inside those bytes at
all. The same history also now powers Time-Travel replay (see
routers/rooms.py's /history endpoint) - the per-update timestamp is
only needed for that; the join/reconnect replay path never looks at it.

Known, deliberate limitation: this history is in-memory only (lost on
restart) and grows unboundedly for the lifetime of a room - the same
"single process, no persistence layer" trade-off already made
everywhere else in this MVP, not a new one introduced here. Fine for a
demo-length session; the real fix (a persisted, periodically
snapshotted Yjs document per room) is future work, same as the
Postgres/S3 persistence gaps already called out elsewhere.
"""
from __future__ import annotations

import time

from fastapi import WebSocket

from app.schemas import UserLeft


class RoomManager:
    def __init__(self) -> None:
        self._rooms: dict[str, dict[WebSocket, str]] = {}
        # Each entry is (recorded_at, update_bytes). recorded_at is a
        # Unix timestamp (time.time()) - wall-clock, not simulated -
        # good enough for a demo-length session's replay slider;
        # nothing here needs sub-second precision or clock-sync
        # guarantees across processes since there's only ever one.
        self._history: dict[str, list[tuple[float, bytes]]] = {}

    async def connect(self, room_id: str, websocket: WebSocket, username: str) -> list[str]:
        """
        Register a new connection and return the usernames of
        everyone already in the room (before this connection was
        added). The caller uses this to send the new joiner a
        snapshot of who's already there - otherwise a new joiner has
        no way to know who else is present, which is the peer-count
        bug: existing members get told about every arrival, but
        arrivals were never told about existing members.
        """
        await websocket.accept()
        room = self._rooms.setdefault(room_id, {})
        existing_usernames = list(room.values())
        room[websocket] = username
        return existing_usernames

    def get_history(self, room_id: str) -> list[bytes]:
        """Every raw Yjs update ever relayed through this room, in order, for replaying to a (re)joining client."""
        return [update for _recorded_at, update in self._history.get(room_id, [])]

    def get_history_with_timestamps(self, room_id: str) -> list[tuple[float, bytes]]:
        """Same history as get_history, but keeping each update's recorded_at - for Time-Travel replay, which needs an actual time axis rather than just an update count."""
        return self._history.get(room_id, [])

    def record_update(self, room_id: str, message: bytes) -> None:
        """Append a binary Yjs update to this room's replay history - called for every update broadcast, not just the first per room."""
        self._history.setdefault(room_id, []).append((time.time(), message))

    def disconnect(self, room_id: str, websocket: WebSocket) -> bool:
        """
        Remove a connection if it's still registered. Returns True if
        it actually was (and is now removed), False if it was already
        gone - e.g. broadcast() already found it dead mid-send and
        cleaned it up (and announced it) itself. The caller uses this
        to avoid broadcasting a second UserLeft for the same departure,
        which would otherwise double-decrement everyone's peer count.
        """
        room = self._rooms.get(room_id)
        if not room or websocket not in room:
            return False
        room.pop(websocket, None)
        if not room:
            # Nobody left in the room - drop the empty dict instead of
            # holding onto memory for rooms nobody's in anymore.
            del self._rooms[room_id]
        return True

    async def broadcast(self, room_id: str, sender: WebSocket, message: bytes | str) -> None:
        """
        Forward a message to everyone in the room except the sender.

        A send failing for any ONE stale connection (its tab/process
        already gone, but this server hasn't yet run the normal
        WebSocketDisconnect cleanup for it in ws.py) must not be
        allowed to take the whole broadcast down. Previously, that
        exception propagated straight out of this call - which meant
        it crashed the SENDER's own request-handling loop too,
        disconnecting an innocent, still-connected user purely as a
        side effect of some other peer's connection going stale first.
        This is why a single dropped tab could knock multiple other
        people offline at once.
        """
        room = self._rooms.get(room_id, {})
        dead: list[tuple[WebSocket, str]] = []

        # Iterate a snapshot, not the live dict - dead connections get
        # popped from the real dict below, after the loop finishes.
        for connection, peer_username in list(room.items()):
            if connection is sender:
                continue
            try:
                if isinstance(message, bytes):
                    await connection.send_bytes(message)
                else:
                    await connection.send_text(message)
            except Exception:
                dead.append((connection, peer_username))

        if not dead:
            return

        for connection, _peer_username in dead:
            room.pop(connection, None)

        # Tell everyone still genuinely connected that these peers are
        # gone - without this, their peer count silently drifts
        # upward forever, since ws.py's own UserLeft broadcast never
        # runs for a connection that was cleaned up here instead of
        # via its own receive loop noticing the disconnect.
        for _connection, peer_username in dead:
            left_message = UserLeft(username=peer_username).model_dump_json()
            for remaining_connection in list(room.keys()):
                try:
                    await remaining_connection.send_text(left_message)
                except Exception:
                    pass  # that connection is stale too - it'll be cleaned up the next time something is broadcast

    def room_size(self, room_id: str) -> int:
        return len(self._rooms.get(room_id, {}))


# Single shared instance - fine as long as we're running one process.
room_manager = RoomManager()
