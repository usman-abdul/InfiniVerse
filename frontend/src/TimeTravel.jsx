import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { Stage, Layer, Line, Rect, Ellipse, Text, Group, Arrow, Image as KonvaImage } from "react-konva";
import { getRoomHistory } from "./api";
import { getAllShapesBounds, trianglePoints, starPoints, stickyTextBox, rotationGroupProps, konvaFontStyle } from "./Canvas";
import { useHtmlImage } from "./useHtmlImage";

const DEFAULT_COLOR = "#2B2B2E";
const BASE_PLAYBACK_INTERVAL_MS = 350; // ms between auto-advanced steps at 1x speed
const SPEED_OPTIONS = [0.5, 1, 2, 4];
const VIEW_PADDING = 60; // world-space breathing room around fitted content
const MIN_SCALE = 0.1;
const MAX_SCALE = 4;
const ZOOM_FACTOR = 1.03;

function formatDuration(ms) {
  const totalSeconds = Math.floor((ms || 0) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const COALESCE_GAP_SECONDS = 0.5; // updates recorded within this gap of each other collapse into one Time Travel step

// Applies every update into a throwaway Y.Doc, one at a time - this is
// what turns "a list of raw CRDT operations" into "the board's actual
// state at every point in the session." Entirely separate from the
// room's live Y.Doc in useYjsRoom.js; nothing here is ever written
// back anywhere, it's pure playback.
//
// Deliberately does NOT snapshot after every single update, though -
// ordinary dragging (and pen strokes) call updateShape on every
// single pointer-move tick, unthrottled, so one two-second drag alone
// can produce 60+ raw updates. Treating each of those as its own
// Time Travel step would mean crawling through hundreds of
// near-identical micro-steps for what's really "five real actions."
// Instead, a step is only recorded once there's a genuine pause
// (COALESCE_GAP_SECONDS) since the last update - a continuous burst
// of activity (a whole drag, a whole stroke) collapses into a single
// step showing its end result, while two genuinely separate actions
// with a natural gap between them stay as two steps.
function buildSteps(updates) {
  const doc = new Y.Doc();
  const shapesMap = doc.getMap("shapes");
  const snapshots = [];
  const timestamps = [];
  for (let i = 0; i < updates.length; i++) {
    const update = updates[i];
    Y.applyUpdate(doc, base64ToBytes(update.data));
    const next = updates[i + 1];
    const isBurstBoundary = !next || next.t - update.t >= COALESCE_GAP_SECONDS;
    if (isBurstBoundary) {
      // Shallow-copy each shape - defensive only; Yjs values here are
      // already plain JS objects (see useYjsRoom's addShape), but a
      // snapshot shouldn't share references with future map mutations.
      snapshots.push(Array.from(shapesMap.values()).map((shape) => ({ ...shape })));
      timestamps.push(update.t);
    }
  }
  return { snapshots, timestamps };
}

function ReplayImage({ shape }) {
  const image = useHtmlImage(shape.url);
  if (!image) return null;
  return (
    <KonvaImage image={image} x={shape.x} y={shape.y} width={shape.width} height={shape.height} listening={false} />
  );
}

// Deliberately read-only mirror of Canvas.jsx's shape rendering (no
// drag/resize/select handlers, no play/pause state for audio) - kept
// as a separate lightweight renderer rather than reusing Canvas.jsx
// directly, since that component is tightly coupled to live editing
// and isn't meant to be instantiated a second time for playback.
function ReplayShape({ shape }) {
  const type = shape.type || "stroke";

  if (type === "stroke") {
    return (
      <Line
        points={shape.points}
        stroke={shape.color}
        strokeWidth={shape.strokeWidth}
        lineCap="round"
        lineJoin="round"
        tension={0.4}
        listening={false}
      />
    );
  }
  if (type === "rect") {
    return (
      <Group {...rotationGroupProps(shape)}>
        <Rect
          x={shape.x}
          y={shape.y}
          width={shape.width}
          height={shape.height}
          stroke={shape.color}
          strokeWidth={shape.strokeWidth || 2}
          listening={false}
        />
      </Group>
    );
  }
  if (type === "ellipse") {
    return (
      <Group {...rotationGroupProps(shape)}>
        <Ellipse
          x={shape.x + shape.width / 2}
          y={shape.y + shape.height / 2}
          radiusX={shape.width / 2}
          radiusY={shape.height / 2}
          stroke={shape.color}
          strokeWidth={shape.strokeWidth || 2}
          listening={false}
        />
      </Group>
    );
  }
  if (type === "triangle") {
    return (
      <Group {...rotationGroupProps(shape)}>
        <Line
          points={trianglePoints(shape.x, shape.y, shape.width, shape.height)}
          closed
          stroke={shape.color}
          strokeWidth={shape.strokeWidth || 2}
          listening={false}
        />
      </Group>
    );
  }
  if (type === "star") {
    return (
      <Group {...rotationGroupProps(shape)}>
        <Line
          points={starPoints(shape.x, shape.y, shape.width, shape.height)}
          closed
          stroke={shape.color}
          strokeWidth={shape.strokeWidth || 2}
          listening={false}
        />
      </Group>
    );
  }
  if (type === "arrow") {
    return (
      <Group {...rotationGroupProps(shape)}>
        <Arrow
          points={[shape.x, shape.y, shape.x + shape.width, shape.y + shape.height]}
          stroke={shape.color}
          fill={shape.color}
          strokeWidth={shape.strokeWidth || 2}
          pointerLength={14}
          pointerWidth={12}
          listening={false}
        />
      </Group>
    );
  }
  if (type === "text") {
    return (
      <Text
        x={shape.x}
        y={shape.y}
        text={shape.text}
        fontSize={shape.fontSize}
        fontFamily={shape.fontFamily || "Inter, system-ui, sans-serif"}
        fontStyle={konvaFontStyle(shape)}
        fill={shape.color}
        listening={false}
      />
    );
  }
  if (type === "sticky") {
    const stickyKind = shape.shapeKind || "rect";
    const textBox = stickyTextBox(shape);
    return (
      <Group listening={false} {...rotationGroupProps(shape)}>
        {stickyKind === "ellipse" ? (
          <Ellipse
            x={shape.x + shape.width / 2}
            y={shape.y + shape.height / 2}
            radiusX={shape.width / 2}
            radiusY={shape.height / 2}
            fill={shape.color}
          />
        ) : stickyKind === "triangle" ? (
          <Line points={trianglePoints(shape.x, shape.y, shape.width, shape.height)} closed fill={shape.color} />
        ) : stickyKind === "star" ? (
          <Line points={starPoints(shape.x, shape.y, shape.width, shape.height)} closed fill={shape.color} />
        ) : (
          <Rect x={shape.x} y={shape.y} width={shape.width} height={shape.height} fill={shape.color} cornerRadius={4} />
        )}
        {(() => {
          return (
            <Text
              x={textBox.x}
              y={textBox.y}
              width={textBox.width}
              height={textBox.height}
              text={shape.text}
              fontSize={shape.fontSize}
              fontFamily={shape.fontFamily || "Inter, system-ui, sans-serif"}
              fontStyle={konvaFontStyle(shape)}
              align={shape.align || "left"}
              fill={DEFAULT_COLOR}
              wrap="word"
              ellipsis
            />
          );
        })()}
      </Group>
    );
  }
  if (type === "audio") {
    const cx = shape.x + shape.width / 2;
    const cy = shape.y + shape.height / 2;
    return (
      <Group listening={false}>
        <Rect
          x={shape.x}
          y={shape.y}
          width={shape.width}
          height={shape.height}
          fill="#fff"
          stroke={DEFAULT_COLOR}
          strokeWidth={1.5}
          cornerRadius={shape.height / 2}
        />
        {/* Always the paused/play-triangle glyph - replay never plays audio back, so there's no "currently playing" state to show */}
        <Line points={[cx - 6, cy - 8, cx - 6, cy + 8, cx + 9, cy]} closed fill={DEFAULT_COLOR} />
        <Text
          x={shape.x - 10}
          y={shape.y + shape.height + 4}
          width={shape.width + 20}
          align="center"
          text={formatDuration(shape.durationMs)}
          fontSize={11}
          fontFamily="Inter, system-ui, sans-serif"
          fill="#6b6a67"
        />
      </Group>
    );
  }
  if (type === "image") {
    return (
      <Group {...rotationGroupProps(shape)}>
        <ReplayImage shape={shape} />
      </Group>
    );
  }
  return null;
}

function TimeTravelShell({ onClose, children }) {
  return (
    <div className="time-travel-overlay" onClick={onClose}>
      <div className="time-travel-modal" onClick={(e) => e.stopPropagation()}>
        <div className="time-travel-header">
          <h2>Time Travel</h2>
          <button className="ghost" onClick={onClose}>
            &#10005;
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// Shared fit-to-bounds math, used both for the one-time initial
// camera and for the on-demand Recenter button - same reasoning as
// Canvas.jsx's own recenter, just operating on a snapshot's shapes
// instead of the live shapes array.
function fitCameraToShapes(shapes, stageSize) {
  const bounds = getAllShapesBounds(shapes);
  if (!bounds) {
    // Nothing to frame - center on the origin at a neutral zoom
    // rather than divide by zero.
    return { scale: 1, x: stageSize.width / 2, y: stageSize.height / 2 };
  }
  const contentWidth = Math.max(bounds.maxX - bounds.minX, 1);
  const contentHeight = Math.max(bounds.maxY - bounds.minY, 1);
  const fitScale = Math.min(
    (stageSize.width - VIEW_PADDING * 2) / contentWidth,
    (stageSize.height - VIEW_PADDING * 2) / contentHeight
  );
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, fitScale));
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  return {
    scale,
    x: stageSize.width / 2 - centerX * scale,
    y: stageSize.height / 2 - centerY * scale,
  };
}

export default function TimeTravel({ roomId, onClose }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [timestamps, setTimestamps] = useState([]);
  const [stepIndex, setStepIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  // The camera is deliberately NOT recomputed on every scrub step -
  // see the long comment below for why. null until the initial fit
  // runs once, after snapshots finish loading.
  const [camera, setCamera] = useState(null);
  const stageRef = useRef(null);

  // Fixed for the lifetime of this modal (computed once at mount,
  // never recalculated) - simpler than tracking window resizes for
  // what's meant to be a short-lived overlay.
  const [stageSize] = useState(() => ({
    width: Math.min(window.innerWidth * 0.85, 960),
    height: Math.min(window.innerHeight * 0.6, 600),
  }));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { updates } = await getRoomHistory(roomId);
        if (cancelled) return;
        const { snapshots: built, timestamps: builtTimestamps } = buildSteps(updates);
        setSnapshots(built);
        setTimestamps(builtTimestamps);
        // Start at the beginning of the session, not the end - this
        // is a replay, so Play should immediately do something
        // without the user first having to drag the scrubber back to
        // zero themselves.
        setStepIndex(0);

        // One-time initial camera, fit to the union of every shape
        // that appears in ANY snapshot - not any single step's
        // shapes. This just needs to be a reasonable starting point
        // that doesn't clip anything obviously important; the user
        // owns the camera completely from here on (see the comment
        // on the camera state above).
        const lastSeenById = new Map();
        built.forEach((snapshot) => {
          snapshot.forEach((shape) => lastSeenById.set(shape.id, shape));
        });
        setCamera(fitCameraToShapes(Array.from(lastSeenById.values()), stageSize));

        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err.message || "Couldn't load this room's history.");
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stageSize is fixed at mount, intentionally excluded to avoid re-fetching on it
  }, [roomId]);

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      setStepIndex((i) => {
        if (i >= snapshots.length - 1) {
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, BASE_PLAYBACK_INTERVAL_MS / speed);
    return () => clearInterval(timer);
  }, [playing, snapshots.length, speed]);

  // Reframes to whatever's on the board AT THE CURRENT STEP - an
  // on-demand action (a button), not something that runs
  // automatically. This is the middle ground between the two
  // approaches that didn't work:
  //   - one camera fixed for the whole session: early steps (a
  //     single sticky note) get scaled down to fit alongside
  //     everything the room ever contained, so they're tiny
  //   - re-fitting automatically on every scrub step: by the final
  //     steps, that's the SAME whole-session view anyway, since
  //     everything that will ever exist, exists by then - there's no
  //     way to "fit everything" without zooming out to fit everything
  // Manual control sidesteps both: the user's own pan/zoom is never
  // touched by scrubbing, and this button is there for when they
  // genuinely want to reframe, on their own terms.
  const handleRecenter = () => {
    setCamera(fitCameraToShapes(snapshots[stepIndex] || [], stageSize));
  };

  const handleWheel = (e) => {
    e.evt.preventDefault();
    if (!camera) return;
    const stage = stageRef.current;
    const pointer = stage?.getPointerPosition();
    if (!pointer) return;

    // Same gesture split as the live canvas (Canvas.jsx's own
    // handleWheel): plain scroll pans, Ctrl/Cmd+scroll zooms, anchored
    // to the cursor so whatever's under the pointer stays put.
    if (e.evt.ctrlKey || e.evt.metaKey) {
      const worldBeforeZoom = {
        x: (pointer.x - camera.x) / camera.scale,
        y: (pointer.y - camera.y) / camera.scale,
      };
      const direction = e.evt.deltaY > 0 ? -1 : 1;
      const newScale =
        direction > 0
          ? Math.min(MAX_SCALE, camera.scale * ZOOM_FACTOR)
          : Math.max(MIN_SCALE, camera.scale / ZOOM_FACTOR);
      setCamera({
        scale: newScale,
        x: pointer.x - worldBeforeZoom.x * newScale,
        y: pointer.y - worldBeforeZoom.y * newScale,
      });
      return;
    }

    setCamera((prev) => ({
      ...prev,
      x: prev.x - e.evt.deltaX,
      y: prev.y - e.evt.deltaY,
    }));
  };

  const handleDragEnd = (e) => {
    setCamera((prev) => ({ ...prev, x: e.target.x(), y: e.target.y() }));
  };

  // { distance, scale, midpointWorld } while a two-finger pinch is in
  // progress - the only way to zoom on a touchscreen, since there's
  // no wheel event to hook into there. Same pattern as Canvas.jsx's
  // own pinch handling.
  const pinchRef = useRef(null);

  const getTouchDistance = (touches) => {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  };

  const getTouchMidpointInContainer = (touches) => {
    const rect = stageRef.current.container().getBoundingClientRect();
    return {
      x: (touches[0].clientX + touches[1].clientX) / 2 - rect.left,
      y: (touches[0].clientY + touches[1].clientY) / 2 - rect.top,
    };
  };

  const handleTouchStart = (e) => {
    if (!e.evt.touches || e.evt.touches.length !== 2 || !camera) return;
    // A second finger touching down means "start a pinch," full stop -
    // stopDrag() cancels any single-finger pan Konva's own draggable
    // handling may have already started with the first finger, so the
    // two gestures don't fight over the camera's position.
    stageRef.current?.stopDrag();
    const midpoint = getTouchMidpointInContainer(e.evt.touches);
    pinchRef.current = {
      distance: getTouchDistance(e.evt.touches),
      scale: camera.scale,
      midpointWorld: {
        x: (midpoint.x - camera.x) / camera.scale,
        y: (midpoint.y - camera.y) / camera.scale,
      },
    };
  };

  const handleTouchMove = (e) => {
    if (!e.evt.touches || e.evt.touches.length !== 2 || !pinchRef.current) return;
    e.evt.preventDefault();
    const { distance: startDistance, scale: startScale, midpointWorld } = pinchRef.current;
    const distance = getTouchDistance(e.evt.touches);
    const midpoint = getTouchMidpointInContainer(e.evt.touches);
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, startScale * (distance / startDistance)));
    setCamera({
      scale: newScale,
      x: midpoint.x - midpointWorld.x * newScale,
      y: midpoint.y - midpointWorld.y * newScale,
    });
  };

  const handleTouchEnd = (e) => {
    if (!e.evt.touches || e.evt.touches.length < 2) {
      pinchRef.current = null;
    }
  };

  const cycleSpeed = () => {
    setSpeed((current) => SPEED_OPTIONS[(SPEED_OPTIONS.indexOf(current) + 1) % SPEED_OPTIONS.length]);
  };

  if (loading) {
    return (
      <TimeTravelShell onClose={onClose}>
        <p className="time-travel-status">Loading this room's history&hellip;</p>
      </TimeTravelShell>
    );
  }

  if (error) {
    return (
      <TimeTravelShell onClose={onClose}>
        <p className="time-travel-status">{error}</p>
      </TimeTravelShell>
    );
  }

  if (snapshots.length === 0 || !camera) {
    return (
      <TimeTravelShell onClose={onClose}>
        <p className="time-travel-status">
          Nothing to replay yet - this room's history is empty (or the backend has restarted since
          anyone last drew here; history is in-memory only).
        </p>
      </TimeTravelShell>
    );
  }

  const currentShapes = snapshots[stepIndex];
  const orderedShapes = [...currentShapes].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
  const currentTime = new Date(timestamps[stepIndex] * 1000);

  return (
    <TimeTravelShell onClose={onClose}>
      <div className="time-travel-canvas-wrap">
        <Stage
          ref={stageRef}
          width={stageSize.width}
          height={stageSize.height}
          x={camera.x}
          y={camera.y}
          scaleX={camera.scale}
          scaleY={camera.scale}
          draggable
          onDragEnd={handleDragEnd}
          onWheel={handleWheel}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          <Layer>
            {orderedShapes.map((shape) => (
              <ReplayShape key={shape.id} shape={shape} />
            ))}
          </Layer>
        </Stage>
      </div>
      <div className="time-travel-controls">
        <button className="ghost" onClick={() => setPlaying((p) => !p)}>
          {playing ? "Pause" : "Play"}
        </button>
        <button className="ghost time-travel-speed" onClick={cycleSpeed} title="Playback speed">
          {speed}x
        </button>
        <input
          type="range"
          min={0}
          max={snapshots.length - 1}
          value={stepIndex}
          onChange={(e) => {
            setPlaying(false);
            setStepIndex(Number(e.target.value));
          }}
          className="time-travel-scrubber"
        />
        <span className="time-travel-timestamp">{currentTime.toLocaleTimeString()}</span>
        <button className="ghost" onClick={handleRecenter} title="Reframe to what's on the board right now">
          Recenter
        </button>
      </div>
      <p className="time-travel-step-count">
        Edit {stepIndex + 1} of {snapshots.length} &middot; drag or scroll to pan, Ctrl/Cmd+scroll or pinch to zoom
      </p>
    </TimeTravelShell>
  );
}
