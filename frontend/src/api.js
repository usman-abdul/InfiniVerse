const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

export async function createRoom(name) {
  const res = await fetch(`${API_URL}/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name || undefined }),
  });
  if (!res.ok) {
    throw new Error(`Couldn't create room (${res.status})`);
  }
  return res.json();
}

export async function getRoom(roomId) {
  const res = await fetch(`${API_URL}/rooms/${roomId}`);
  if (!res.ok) {
    throw new Error(`Room not found (${res.status})`);
  }
  return res.json();
}

// Every raw Yjs update ever relayed through this room's WebSocket, in
// order, each tagged with when it was recorded - see backend
// app/routers/rooms.py's docstring for why this is a plain str
// room_id, not a validated UUID. Powers Time-Travel replay
// (TimeTravel.jsx applies these one at a time into a throwaway Y.Doc).
export async function getRoomHistory(roomId) {
  const res = await fetch(`${API_URL}/rooms/${roomId}/history`);
  if (!res.ok) {
    throw new Error(`Couldn't load this room's history (${res.status})`);
  }
  return res.json(); // { updates: [{ t, data }, ...] }
}

export async function uploadImage(roomId, file) {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch(`${API_URL}/rooms/${roomId}/uploads`, {
    method: "POST",
    body: formData,
  });
  if (!res.ok) {
    // 415 = wrong content type, 413 = too large - both come straight
    // from the backend's own validation, see app/routers/uploads.py.
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Upload failed (${res.status})`);
  }
  const data = await res.json();
  // The backend returns a relative path (e.g. "/uploads/<room>/<file>")
  // since it doesn't know its own public URL - resolve it to absolute
  // here, once, so nothing downstream needs to know API_URL exists.
  return { ...data, url: `${API_URL}${data.url}` };
}

// Same endpoint and same shape as uploadImage - the backend upload
// route was already generic (any allowed content type), it just
// didn't have audio in its allow-list until now. Kept as a separate
// function anyway (rather than reusing uploadImage directly) since a
// MediaRecorder result is a Blob, not a File, and doesn't come with a
// filename - FormData needs one supplied explicitly or the backend
// falls back to a generated name with no extension.
export async function uploadAudio(roomId, blob) {
  const formData = new FormData();
  const extension = blob.type.includes("ogg") ? "ogg" : blob.type.includes("mp4") ? "mp4" : "webm";
  formData.append("file", blob, `recording.${extension}`);
  const res = await fetch(`${API_URL}/rooms/${roomId}/uploads`, {
    method: "POST",
    body: formData,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Upload failed (${res.status})`);
  }
  const data = await res.json();
  return { ...data, url: `${API_URL}${data.url}` };
}
