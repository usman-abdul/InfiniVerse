import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";

const WS_URL = import.meta.env.VITE_WS_URL || "ws://localhost:8000";

// How often we resend our own viewport even if it hasn't changed -
// this is what lets peers detect we've gone stale (see PEER_STALE_MS)
// without needing a clean disconnect message, which a crashed tab or
// dropped network never sends.
const HEARTBEAT_INTERVAL_MS = 4000;
// A peer's dot is dropped from the map if we haven't heard from them
// in this long - generous relative to the heartbeat above (roughly
// 2-3 missed beats) so one delayed message doesn't flicker a dot away.
const PEER_STALE_MS = 10000;
const PEER_PRUNE_INTERVAL_MS = 3000;

/**
 * Wires a Y.Doc to two things:
 *
 *  - y-indexeddb, an offline-first local cache. Works with zero
 *    network - drawing, editing, everything keeps working locally;
 *    it just won't reach anyone else until reconnected.
 *
 *  - our own backend's WebSocket relay, via a hand-rolled provider
 *    rather than the standard y-websocket client. The backend (see
 *    backend/app/ws_manager.py) replays every update it's ever seen
 *    for a room to each new/reconnecting client, and this hook sends
 *    its own full current doc state on every successful (re)connect
 *    (see ws.onopen below) - between those two, whichever direction
 *    changes happened in while disconnected, they reach everyone once
 *    back online. Neither side needs to actually parse Yjs's binary
 *    format to make this work; CRDT updates are safe to replay
 *    verbatim, in bulk, in any order.
 *
 * @param {{ onUserJoined?: (username: string) => void }} [options]
 */
export function useYjsRoom(roomId, username, options = {}) {
  const ydoc = useMemo(() => new Y.Doc(), [roomId]);
  const shapesMap = useMemo(() => ydoc.getMap("shapes"), [ydoc]);

  // A random id for THIS connection, distinct from username. Usernames
  // aren't unique - two people can (and, per testing, do) join with
  // the same name - so anything keyed by username alone will collide
  // and silently merge two different people into one entry. This id
  // is what viewport messages are actually keyed by.
  const clientId = useMemo(() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`, []);

  const [shapes, setShapes] = useState([]);
  const [connected, setConnected] = useState(false);
  const [peerCount, setPeerCount] = useState(0);
  // Last-known viewport for every OTHER connected user, keyed by their
  // clientId (not username - see above). Each entry also carries the
  // username it was last seen with, for display/coloring, plus
  // updatedAt so the staleness sweep below can drop peers who
  // disappeared without a clean disconnect. Fed by "viewport" text
  // messages, which piggyback on the exact same broadcast mechanism
  // already used for join/leave, so no backend changes are needed to
  // relay them. Powers the mini-map's peer dots.
  const [peerViewports, setPeerViewports] = useState({});

  const wsRef = useRef(null);
  // Our own last-sent viewport, kept outside React state (a ref, not
  // state) purely so the heartbeat and "someone just joined - resend
  // our position immediately" logic below can read it without needing
  // to be re-created every time the viewport changes.
  const lastViewportRef = useRef(null);
  // Latest onUserJoined callback, read through a ref rather than added
  // to the connect effect's dependency array - Room.jsx passes a new
  // function identity on every render, and reconnecting the whole
  // socket every render just to pick up a fresh callback would be a
  // much worse trade than this one extra ref indirection.
  const onUserJoinedRef = useRef(options.onUserJoined);
  useEffect(() => {
    onUserJoinedRef.current = options.onUserJoined;
  });

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer = null;
    let attempt = 0;
    let ws = null;

    const persistence = new IndexeddbPersistence(`canvas-${roomId}`, ydoc);

    const syncShapes = () => setShapes(Array.from(shapesMap.values()));
    shapesMap.observe(syncShapes);
    syncShapes();

    const onDocUpdate = (update, origin) => {
      // Only broadcast updates that originated locally. Re-sending an
      // update we just received from the socket would echo it right
      // back out - harmless to Yjs (updates are idempotent) but pure
      // wasted bandwidth, so we skip it.
      if (origin === "remote") return;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(update);
      }
    };
    ydoc.on("update", onDocUpdate);

    const connect = () => {
      if (cancelled) return;

      const wsUrl = `${WS_URL}/ws/${roomId}?username=${encodeURIComponent(username)}`;
      ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0; // back to a fast retry next time, now that we know the connection can succeed
        setConnected(true);
        // Push everything currently in the local doc, not just new
        // updates going forward. This is what actually gets edits
        // made while offline out to everyone else - the normal
        // onDocUpdate send below only fires for updates that happen
        // AFTER this point, so without this, anything drawn while
        // disconnected would stay stuck locally forever once the
        // socket closed mid-edit. Redundant for state the room
        // already has, but Yjs updates are safe to resend - the
        // receiving end just merges a no-op for anything it already
        // knows.
        ws.send(Y.encodeStateAsUpdate(ydoc));

        // Canvas reports its initial viewport as soon as it mounts,
        // which can easily happen before this socket finishes
        // connecting - that first sendViewport() call sets
        // lastViewportRef but has nothing open to send over yet.
        // Without this, we'd otherwise wait for the next heartbeat
        // (up to HEARTBEAT_INTERVAL_MS later) before anyone else
        // learns where we're looking.
        if (lastViewportRef.current) {
          ws.send(JSON.stringify({ type: "viewport", username, clientId, ...lastViewportRef.current }));
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        setConnected(false);
        // We no longer have live knowledge of who's actually in the
        // room while disconnected - showing a stale number from
        // before the drop would be misleading. room_state resupplies
        // the real count the instant we're back.
        setPeerCount(0);
        // Same logic for peer viewports - a peer's last-known dot on
        // the mini-map is meaningless once we've lost our own
        // connection to the room.
        setPeerViewports({});
        const delay = Math.min(1000 * 2 ** attempt, 10000);
        attempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      };

      // onerror is always immediately followed by onclose for a
      // WebSocket, so the reconnect scheduling above already covers
      // this - this handler just exists to avoid an unhandled error
      // being logged on every dropped connection.
      ws.onerror = () => {};

      ws.onmessage = (event) => {
        if (typeof event.data === "string") {
          // Text frames are our small JSON control messages
          // (user_joined / user_left) - see backend/app/schemas.py.
          try {
            const msg = JSON.parse(event.data);
            // Sent once, right after connecting: tells us who was
            // already in the room, fixing the bug where a new joiner
            // always started at a peer count of 0 regardless of who
            // else was actually present (see backend/app/schemas.py).
            if (msg.type === "room_state") setPeerCount(msg.peers.length);
            if (msg.type === "user_joined") {
              setPeerCount((n) => n + 1);
              onUserJoinedRef.current?.(msg.username);
              // A brand-new joiner has no idea where we're currently
              // looking until our next throttled broadcast (see
              // sendViewport below) - which could be seconds away if
              // we're not actively panning/zooming. Resending our
              // last-known position immediately closes that gap
              // instead of leaving our dot missing from their
              // mini-map until we happen to move.
              if (lastViewportRef.current && ws && ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({ type: "viewport", username, clientId, ...lastViewportRef.current })
                );
              }
            }
            if (msg.type === "user_left") {
              setPeerCount((n) => Math.max(0, n - 1));
              setPeerViewports((prev) => {
                // The backend's user_left message only carries a
                // username, not a clientId (see schemas.py) - fine
                // when that username is unique among current peers,
                // but if two peers share a name we genuinely can't
                // tell which one just left from this message alone.
                // Removing the wrong one would be worse than a brief
                // delay, so in that ambiguous case we leave both dots
                // in place and let the staleness sweep below quietly
                // drop the one that stops sending heartbeats.
                const matchingIds = Object.keys(prev).filter((id) => prev[id].username === msg.username);
                if (matchingIds.length !== 1) return prev;
                const next = { ...prev };
                delete next[matchingIds[0]];
                return next;
              });
            }
            // Another peer's current viewport - throttled and sent by
            // their own sendViewport() below. This isn't a
            // backend-defined message type (see schemas.py); it's
            // relayed blindly along with any other text frame, so no
            // backend changes were needed to add it. The backend
            // never echoes a message back to its own sender, so
            // there's no need to filter out our own clientId here.
            if (msg.type === "viewport") {
              setPeerViewports((prev) => ({
                ...prev,
                [msg.clientId]: {
                  username: msg.username,
                  x: msg.x,
                  y: msg.y,
                  width: msg.width,
                  height: msg.height,
                  updatedAt: Date.now(),
                },
              }));
            }
          } catch {
            // Not JSON we understand - ignore rather than crash the app.
          }
          return;
        }
        // Binary frames are raw Yjs update bytes - apply directly.
        const update = new Uint8Array(event.data);
        Y.applyUpdate(ydoc, update, "remote");
      };
    };

    connect();

    return () => {
      // Note: we deliberately do NOT call ydoc.destroy() here. ydoc
      // is memoized on roomId (not recreated by this effect), but in
      // dev, React.StrictMode mounts -> unmounts -> remounts effects
      // once to catch missing cleanup. Destroying the memoized doc on
      // that first cleanup would leave the second mount holding a
      // dead doc. ws and the IndexedDB binding ARE recreated fresh
      // each effect run, so those are safe to tear down here.
      //
      // cancelled is set BEFORE ws.close() so the onclose handler
      // above (which fires asynchronously) sees it and skips
      // scheduling a reconnect - otherwise a deliberate teardown
      // (leaving the room, changing roomId) would look identical to a
      // dropped connection and keep retrying forever in the background.
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      shapesMap.unobserve(syncShapes);
      ydoc.off("update", onDocUpdate);
      if (ws) ws.close();
      persistence.destroy();
    };
  }, [roomId, username, ydoc, shapesMap]);

  // Two independent timers, both scoped to this connection's lifetime:
  //  - heartbeat: resend our own last-known viewport periodically even
  //    if nothing changed, so a peer who's idle-but-still-here doesn't
  //    silently age out of everyone else's staleness sweep.
  //  - prune: drop any peer we haven't heard a viewport from recently.
  //    This is the real cleanup mechanism (not user_left) - it works
  //    identically whether a peer left cleanly, crashed, or lost
  //    network, and it's immune to the duplicate-username ambiguity
  //    that made user_left-based removal above unreliable.
  useEffect(() => {
    const heartbeat = setInterval(() => {
      const ws = wsRef.current;
      if (lastViewportRef.current && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({ type: "viewport", username, clientId, ...lastViewportRef.current })
        );
      }
    }, HEARTBEAT_INTERVAL_MS);

    const prune = setInterval(() => {
      setPeerViewports((prev) => {
        const now = Date.now();
        let changed = false;
        const next = {};
        for (const [id, peer] of Object.entries(prev)) {
          if (now - peer.updatedAt < PEER_STALE_MS) {
            next[id] = peer;
          } else {
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, PEER_PRUNE_INTERVAL_MS);

    return () => {
      clearInterval(heartbeat);
      clearInterval(prune);
    };
  }, [username, clientId]);

  const addShape = useCallback(
    (shape) => {
      shapesMap.set(shape.id, shape);
    },
    [shapesMap]
  );

  // Merges a partial patch into an existing shape (e.g. editing a text
  // shape's `text` field in place). No-ops if the shape was deleted by
  // someone else in the meantime, rather than resurrecting it.
  const updateShape = useCallback(
    (id, patch) => {
      const existing = shapesMap.get(id);
      if (!existing) return;
      shapesMap.set(id, { ...existing, ...patch });
    },
    [shapesMap]
  );

  const deleteShape = useCallback(
    (id) => {
      shapesMap.delete(id);
    },
    [shapesMap]
  );

  // Broadcasts our current world-space viewport rect ({ x, y, width,
  // height }) to everyone else in the room, for the mini-map's "here's
  // where each person is looking" dots. The caller (Room.jsx) is
  // responsible for throttling how often this gets called - this
  // function itself just sends whatever it's given, once, and
  // remembers it so a newly-joining peer can be caught up instantly
  // (see the user_joined handler above).
  //
  // Wrapped in useCallback with a stable identity (wsRef/lastViewportRef
  // are refs, so they don't need to be dependencies) - without this,
  // a new function every render here was the root cause of an infinite
  // render loop: Room.jsx's handleViewportChange (useCallback keyed on
  // [sendViewport]) would get a new identity every render too, which
  // fed Canvas.jsx's viewport-report effect (keyed on [..., onViewportChange]),
  // which fires setOwnViewport in Room.jsx on every one of those
  // "changes" - re-rendering Room, producing a new sendViewport, and
  // looping forever ("Maximum update depth exceeded").
  const sendViewport = useCallback(
    (viewport) => {
      lastViewportRef.current = viewport;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "viewport", username, clientId, ...viewport }));
    },
    [username, clientId]
  );

  return {
    shapes,
    addShape,
    updateShape,
    deleteShape,
    connected,
    peerCount,
    peerViewports,
    sendViewport,
    clientId,
  };
}
