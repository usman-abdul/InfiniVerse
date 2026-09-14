import { useState } from "react";
import { createRoom, getRoom } from "./api";

export default function RoomEntry({ onEnter, initialRoomId }) {
  const [roomName, setRoomName] = useState("");
  const [joinId, setJoinId] = useState(initialRoomId || "");
  const [username, setUsername] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const handleCreate = async () => {
    if (!username.trim()) {
      setError("Enter a name first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const room = await createRoom(roomName.trim());
      onEnter(room.id, username.trim(), room.name);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleJoin = async () => {
    if (!username.trim()) {
      setError("Enter a name first.");
      return;
    }
    if (!joinId.trim()) {
      setError("Paste a room ID to join.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const room = await getRoom(joinId.trim());
      onEnter(joinId.trim(), username.trim(), room.name);
    } catch {
      setError("That room ID wasn't found.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="entry">
      <div className="entry-card">
        <p className="eyebrow">Collaborative canvas</p>
        <h1>{initialRoomId ? "You've been invited." : "Draw together, live."}</h1>
        {initialRoomId && (
          <p className="entry-invite-hint">
            Just add your name and hit Join - the room ID's already filled in below.
          </p>
        )}

        <label className="field">
          <span>Your name</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="e.g. Sam"
          />
        </label>

        <div className="entry-split">
          <div className="entry-section">
            <h2>Start a room</h2>
            <input
              value={roomName}
              onChange={(e) => setRoomName(e.target.value)}
              placeholder="Room name (optional)"
            />
            <button className="primary" onClick={handleCreate} disabled={busy}>
              Create room
            </button>
          </div>

          <div className="entry-section">
            <h2>Join a room</h2>
            <input
              value={joinId}
              onChange={(e) => setJoinId(e.target.value)}
              placeholder="Room ID"
            />
            <button onClick={handleJoin} disabled={busy}>
              Join room
            </button>
          </div>
        </div>

        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
