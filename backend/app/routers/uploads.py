"""
REST endpoint for file uploads attached to a room (e.g. images
dropped onto the canvas). Files land on local disk under
uploads/{room_id}/ - see README for why S3 is deliberately out of
scope for now.
"""
from __future__ import annotations

import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import Room, Upload
from app.schemas import UploadOut

router = APIRouter(prefix="/rooms", tags=["uploads"])

UPLOAD_ROOT = Path("uploads")

# Images placed on the canvas, plus audio clips recorded via the
# Audio tool (MediaRecorder in the browser typically produces
# audio/webm; other browsers/formats are allowed too in case a
# recording comes from somewhere else).
ALLOWED_CONTENT_TYPES = {
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "audio/webm",
    "audio/ogg",
    "audio/mpeg",
    "audio/mp4",
    "audio/wav",
}
MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 10 MB


@router.post("/{room_id}/uploads", response_model=UploadOut, status_code=201)
async def upload_file(
    room_id: uuid.UUID,
    file: UploadFile,
    session: AsyncSession = Depends(get_session),
) -> UploadOut:
    room = await session.get(Room, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")

    # Browsers report MediaRecorder output with codec parameters
    # attached (e.g. "audio/webm;codecs=opus"), not the bare mime type
    # - strip everything after the first ";" before checking against
    # the allow-list, or every real-world audio upload gets rejected.
    content_type = (file.content_type or "").split(";")[0].strip()

    if content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=415, detail=f"Unsupported content type: {file.content_type}"
        )

    contents = await file.read()
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File too large (10 MB max)")

    room_dir = UPLOAD_ROOT / str(room_id)
    room_dir.mkdir(parents=True, exist_ok=True)

    upload_id = uuid.uuid4()
    # Keep the extension, drop the user-supplied filename otherwise -
    # avoids path traversal and collisions from untrusted input.
    suffix = Path(file.filename or "").suffix
    stored_name = f"{upload_id}{suffix}"
    (room_dir / stored_name).write_bytes(contents)

    upload = Upload(
        id=upload_id,
        room_id=room_id,
        filename=file.filename or stored_name,
        content_type=content_type,
        size_bytes=len(contents),
    )
    session.add(upload)
    await session.commit()
    await session.refresh(upload)

    return UploadOut(
        id=upload.id,
        filename=upload.filename,
        content_type=upload.content_type,
        size_bytes=upload.size_bytes,
        url=f"/uploads/{room_id}/{stored_name}",
        created_at=upload.created_at,
    )
