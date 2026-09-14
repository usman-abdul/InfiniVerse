"""
Smoke test covering the WebSocket relay's core behavior, including
the room_state fix: a new joiner must be told who's already in the
room, not just have existing members told about them.

Run with: python test_smoke.py
"""
from fastapi.testclient import TestClient

from app.main import app
from app.ws_manager import room_manager

client = TestClient(app)

with client.websocket_connect("/ws/room-a?username=Alex") as alex:
    # Alex is first in - room_state should say "nobody else here".
    alex_state = alex.receive_json()
    assert alex_state == {"type": "room_state", "peers": []}
    print("PASS: Alex's room_state shows no existing peers")

    with client.websocket_connect("/ws/room-a?username=Sam") as sam:
        # THE FIX: Sam should immediately learn Alex is already here,
        # instead of starting at a peer count of 0 like before.
        sam_state = sam.receive_json()
        assert sam_state == {"type": "room_state", "peers": ["Alex"]}
        print("PASS: Sam's room_state correctly lists Alex as already present")

        # Alex, who was already connected, should be told Sam joined.
        alex_sees = alex.receive_json()
        assert alex_sees["type"] == "user_joined" and alex_sees["username"] == "Sam"
        print("PASS: Alex was notified Sam joined")

        # Alex sends a message - Sam (same room) should get it.
        alex.send_text('{"type": "ping", "from": "Alex"}')
        sam_received = sam.receive_json()
        assert sam_received["from"] == "Alex"
        print("PASS: Sam received Alex's message in the same room")

        with client.websocket_connect("/ws/room-b?username=Jordan") as jordan:
            # Jordan is alone in a different room.
            jordan_state = jordan.receive_json()
            assert jordan_state == {"type": "room_state", "peers": []}

            # Room isolation, checked via the server's own bookkeeping
            # rather than blocking on a message that correctly never
            # arrives for a client alone in their room.
            assert room_manager.room_size("room-a") == 2
            assert room_manager.room_size("room-b") == 1
            print("PASS: room-a has 2 members, room-b has 1 - no cross-room leakage")

print("\nAll smoke tests passed.")
