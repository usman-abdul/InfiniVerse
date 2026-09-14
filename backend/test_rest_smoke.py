"""
Quick smoke test for the REST layer: create a room, fetch it, list
it, upload a file to it, confirm bad input is rejected.

Uses an in-memory SQLite DB instead of Postgres so this runs without
docker compose. The models use dialect-neutral SQLAlchemy types for
exactly this reason - swap DATABASE_URL back to Postgres (or just run
via docker compose) and the same code path applies.

Run with: python test_rest_smoke.py
"""
from __future__ import annotations

import asyncio
import io
import os

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

from fastapi.testclient import TestClient  # noqa: E402

from app.db import init_models  # noqa: E402
from app.main import app  # noqa: E402

asyncio.run(init_models())

client = TestClient(app)

# Create a room
resp = client.post("/rooms", json={"name": "Test room"})
assert resp.status_code == 201, resp.text
room = resp.json()
room_id = room["id"]
assert room["name"] == "Test room"
print("PASS: created room", room_id)

# Fetch it back
resp = client.get(f"/rooms/{room_id}")
assert resp.status_code == 200
assert resp.json()["id"] == room_id
print("PASS: fetched room by id")

# List rooms - the one we made should show up
resp = client.get("/rooms")
assert resp.status_code == 200
assert any(r["id"] == room_id for r in resp.json())
print("PASS: room appears in list")

# 404 for a room that was never created
resp = client.get("/rooms/00000000-0000-0000-0000-000000000000")
assert resp.status_code == 404
print("PASS: unknown room returns 404")

# Upload a file to the room
fake_png = io.BytesIO(b"\x89PNG\r\n\x1a\nfakepngbytes")
resp = client.post(
    f"/rooms/{room_id}/uploads",
    files={"file": ("test.png", fake_png, "image/png")},
)
assert resp.status_code == 201, resp.text
upload = resp.json()
assert upload["filename"] == "test.png"
assert upload["url"].startswith(f"/uploads/{room_id}/")
print("PASS: uploaded a file, got back", upload["url"])

# Disallowed content type should be rejected, not silently accepted
resp = client.post(
    f"/rooms/{room_id}/uploads",
    files={"file": ("evil.exe", io.BytesIO(b"nope"), "application/octet-stream")},
)
assert resp.status_code == 415
print("PASS: disallowed content type rejected")

# Uploading to a room that doesn't exist should 404, not create a file
resp = client.post(
    "/rooms/00000000-0000-0000-0000-000000000000/uploads",
    files={"file": ("test.png", io.BytesIO(b"x"), "image/png")},
)
assert resp.status_code == 404
print("PASS: upload to unknown room returns 404")

print("\nAll REST smoke tests passed.")
