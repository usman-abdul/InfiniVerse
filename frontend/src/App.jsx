import { useState } from "react";
import Splash from "./Splash";
import RoomEntry from "./RoomEntry";
import Room from "./Room";

// An invite link looks like ?room=<id> appended to wherever the app
// is hosted (see Room.jsx's Invite button, which is what generates
// these). Read once at load, not on every render - the query string
// isn't going to change out from under us mid-session.
function getInvitedRoomId() {
  return new URLSearchParams(window.location.search).get("room");
}

export default function App() {
  const [invitedRoomId] = useState(getInvitedRoomId);
  // Someone arriving via an invite link is trying to get INTO a room,
  // not admire a loading animation - skip the splash for them and go
  // straight to name entry with the room already filled in.
  const [showSplash, setShowSplash] = useState(!invitedRoomId);
  const [session, setSession] = useState(null); // { roomId, username, roomName } | null

  if (showSplash) {
    return <Splash onFinish={() => setShowSplash(false)} />;
  }

  if (!session) {
    return (
      <RoomEntry
        initialRoomId={invitedRoomId}
        onEnter={(roomId, username, roomName) => setSession({ roomId, username, roomName })}
      />
    );
  }

  return (
    <Room
      roomId={session.roomId}
      username={session.username}
      roomName={session.roomName}
      onLeave={() => setSession(null)}
    />
  );
}
