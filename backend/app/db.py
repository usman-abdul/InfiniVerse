"""
Async SQLAlchemy engine/session setup.

One shared async engine per process, built from DATABASE_URL in the
environment (see .env.example - defaults to the `db` service in
docker-compose). Session-per-request is wired in via the
`get_session` dependency below.

Table creation uses Base.metadata.create_all on startup rather than
Alembic migrations - fine for a hackathon timeline, but the first
thing to replace before this schema needs to change in production
without dropping data.
"""
from __future__ import annotations

import os
from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql+asyncpg://canvas:canvas@localhost:5432/canvas"
)

# SQLite (used by the offline REST smoke test) needs a couple of
# special-cased engine args that Postgres doesn't - an in-memory
# SQLite db is per-connection by default, so without StaticPool each
# new connection would see an empty database.
_engine_kwargs: dict = {}
_connect_args: dict = {}
if DATABASE_URL.startswith("sqlite"):
    from sqlalchemy.pool import StaticPool

    _engine_kwargs["poolclass"] = StaticPool
    _connect_args["check_same_thread"] = False

engine = create_async_engine(DATABASE_URL, echo=False, connect_args=_connect_args, **_engine_kwargs)
async_session = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with async_session() as session:
        yield session


async def init_models() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
