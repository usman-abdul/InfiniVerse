"""
SQLAlchemy models.

These persist room *metadata* and uploaded files - not canvas
content. The Yjs document itself is still in-memory only in
ws_manager.py (see that module's NOTE for what's not yet
implemented). A Room row existing in Postgres and a "room" being
live in the WebSocket relay are two separate, currently-decoupled
things - the ws endpoint doesn't check this table yet. Wiring that
check in is a natural next step, not done here to avoid breaking the
existing Part 1 tests, which connect to rooms that were never
REST-created.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class Room(Base):
    __tablename__ = "rooms"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(200), default="Untitled room")
    created_at: Mapped[datetime] = mapped_column(default=datetime.utcnow)

    uploads: Mapped[list["Upload"]] = relationship(
        back_populates="room", cascade="all, delete-orphan"
    )


class Upload(Base):
    __tablename__ = "uploads"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    room_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("rooms.id"))
    filename: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(100))
    size_bytes: Mapped[int]
    created_at: Mapped[datetime] = mapped_column(default=datetime.utcnow)

    room: Mapped["Room"] = relationship(back_populates="uploads")
