import { useCallback, useEffect, useRef } from "react";

/**
 * Custom, dependency-free physics for thrown/colliding canvas objects.
 *
 * Deliberately NOT matter.js (or any physics library) - the brief
 * explicitly allows "matter.js OR a custom physics engine," and this
 * environment has no way to install or verify an external package
 * end-to-end, so a hand-written system that can be read and checked
 * line-by-line is the safer choice for something a hackathon demo
 * depends on.
 *
 * Scope, matching the app's own conventions:
 *  - Only shapes with a plain x/y/width/height (rect, ellipse,
 *    triangle, star, arrow, sticky, image, audio) participate -
 *    freehand strokes and text don't have a natural axis-aligned box
 *    to collide with, so they're excluded entirely (can't be thrown,
 *    never collide with anything).
 *  - Only rect, ellipse, triangle, and star participate in the
 *    special rules below; images, audio, and arrows still get thrown
 *    and bounce off things like solid objects, they just never
 *    merge/absorb/blend.
 *
 * Rules (a deliberate design, not just "whatever the physics happens
 * to do"):
 *  - two shapes of the identical type (rect+rect, ellipse+ellipse,
 *    triangle+triangle, or star+star), on collision: the bigger one
 *    survives and grows (area-additive - "becomes bigger if there's
 *    a difference in size"), the smaller one is deleted.
 *  - sticky+sticky: both survive, their colors blend to the same new
 *    color. They may have completely different text/content, so
 *    merging them into a single note would silently lose one of them.
 *  - rect/ellipse/triangle/star + sticky: the sticky takes the
 *    shape's outline (a `shapeKind` field), and the shape itself is
 *    deleted.
 *  - two DIFFERENT SPECIAL_TYPES (e.g. rect vs ellipse, or rect vs
 *    triangle): no special rule, just a normal solid bounce.
 *  - anything involving an image, audio clip, or arrow: normal solid
 *    bounce only, never a special rule, on either side of the pair.
 *
 * Position updates while a shape is in motion are throttled (synced
 * to Yjs a few times a second, not every single frame) - the LOCAL
 * visual motion is still smooth 60fps, driven by directly repositioning
 * the shape's own Konva node every frame rather than waiting on a full
 * React re-render each time. Calling updateShape() on every single
 * frame (the original approach, matching how ordinary dragging already
 * works) got noticeably less smooth once more render cost piled onto
 * every shape (rotation Group wrappers, zIndex-sorted render order) -
 * separating "what the thrower sees locally" from "what gets synced
 * to everyone else" fixes that without touching dragging at all.
 */

const FRICTION_PER_SECOND = 0.08; // fraction of velocity retained per second of air friction - was 0.6, which let even a moderate throw travel ~2x its initial speed in world units and take ~10s to fully stop; at this value, a typical throw (~250-600 units/sec) settles in ~1.5-1.8s and travels roughly 15-25% of its initial speed in total distance
const STOP_SPEED = 6; // world units/sec - below this, a moving shape is considered at rest
const MAX_SPEED = 1600; // world units/sec - was 4000; caps how far even the fastest flick can launch something in one go
const ATTRACT_RADIUS = 320; // world units - same-type SPECIAL shapes within this range pull toward each other
const ATTRACT_ACCEL = 700; // world units/sec^2 at point-blank range, falls off linearly with distance
const BOUNCE_RESTITUTION = 0.6; // velocity retained (and reversed) along the collision axis on a plain bounce
const SYNC_INTERVAL_MS = 90; // how often a moving shape's TRUE position gets synced to Yjs while still in flight - local rendering stays 60fps regardless (see renderNodePosition below)

// Participate in the special attract/merge/absorb/blend rules.
const SPECIAL_TYPES = ["rect", "ellipse", "triangle", "star", "sticky"];
// Can be thrown and collide at all (a strict superset of SPECIAL_TYPES).
const PHYSICS_TYPES = ["rect", "ellipse", "triangle", "star", "arrow", "sticky", "image", "audio"];
// Every SPECIAL_TYPES member now has real sticky-note rendering
// support (see Canvas.jsx's shapeKind branch, plus the matching
// triangle/star text-inset helpers) - kept as its own list, separate
// from SPECIAL_TYPES, in case that ever changes again.
const RENDERABLE_STICKY_KINDS = ["rect", "ellipse", "triangle", "star"];

function typeOf(shape) {
  return shape.type || "stroke";
}

function isPhysicsEligible(shape) {
  return PHYSICS_TYPES.includes(typeOf(shape));
}

function boundsOf(shape) {
  return { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function hexToRgb(hex) {
  const clean = (hex || "#999999").replace("#", "");
  return {
    r: parseInt(clean.substring(0, 2), 16) || 0,
    g: parseInt(clean.substring(2, 4), 16) || 0,
    b: parseInt(clean.substring(4, 6), 16) || 0,
  };
}

function rgbToHex({ r, g, b }) {
  const toHex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function blendColors(hexA, hexB) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  return rgbToHex({ r: (a.r + b.r) / 2, g: (a.g + b.g) / 2, b: (a.b + b.b) / 2 });
}

/**
 * Applies the type-based special rules if this pair qualifies.
 * Returns:
 *   "merged-away"    - `shape` was deleted (the smaller of a same-type pair, or a shape a sticky absorbed)
 *   "merged-grew"    - `shape` survived and grew, `other` was deleted
 *   "absorbed-other" - `shape` (a sticky) survived and took on a new outline, `other` was deleted
 *   "blended"        - both survived, colors updated on both
 *   null             - no special rule applies; caller should fall through to a plain bounce
 */
function resolveSpecialCollision(shape, other, doUpdate, doDelete) {
  const typeA = typeOf(shape);
  const typeB = typeOf(other);
  if (!SPECIAL_TYPES.includes(typeA) || !SPECIAL_TYPES.includes(typeB)) return null;

  if (typeA === typeB) {
    if (typeA === "sticky") {
      const blended = blendColors(shape.color, other.color);
      doUpdate(shape.id, { color: blended });
      doUpdate(other.id, { color: blended });
      return "blended";
    }
    // rect+rect or ellipse+ellipse: whichever is bigger survives and
    // grows to the combined area of both - regardless of which one
    // happened to be thrown/moving. (Previously, only the branch
    // where `shape` won ever called doUpdate to grow it; when `other`
    // was the bigger one, it was correctly kept but never actually
    // grew, so the surviving shape's size didn't reflect what it had
    // just absorbed.)
    const areaSelf = shape.width * shape.height;
    const areaOther = other.width * other.height;
    if (areaSelf >= areaOther) {
      const scale = Math.sqrt((areaSelf + areaOther) / areaSelf);
      doUpdate(shape.id, { width: shape.width * scale, height: shape.height * scale });
      doDelete(other.id);
      return "merged-grew";
    }
    const scale = Math.sqrt((areaSelf + areaOther) / areaOther);
    doUpdate(other.id, { width: other.width * scale, height: other.height * scale });
    doDelete(shape.id);
    return "merged-away";
  }

  // rect/ellipse/triangle/star + sticky: the sticky takes the
  // shape's outline (if it's one we can actually render one - see
  // RENDERABLE_STICKY_KINDS), the shape itself disappears either way.
  if (typeA === "sticky") {
    if (RENDERABLE_STICKY_KINDS.includes(typeB)) doUpdate(shape.id, { shapeKind: typeB });
    doDelete(other.id);
    return "absorbed-other";
  }
  if (typeB === "sticky") {
    if (RENDERABLE_STICKY_KINDS.includes(typeA)) doUpdate(other.id, { shapeKind: typeA });
    doDelete(shape.id);
    return "merged-away";
  }

  // Any other pairing of different SPECIAL_TYPES (e.g. rect vs
  // ellipse, or rect vs triangle): no special rule, just a bounce.
  return null;
}

export function usePhysics({ shapes, updateShape, deleteShape, stageRef }) {
  // Latest shapes/mutators, read fresh every animation frame by the
  // loop below without needing to restart it on every render - the
  // loop itself starts once and runs for the component's lifetime.
  const shapesRef = useRef(shapes);
  useEffect(() => {
    shapesRef.current = shapes;
  }, [shapes]);

  const mutatorsRef = useRef({ updateShape, deleteShape });
  useEffect(() => {
    mutatorsRef.current = { updateShape, deleteShape };
  });

  // id -> { vx, vy, x, y, lastSyncAt }. x/y here are the shape's TRUE
  // current position, updated every single frame regardless of how
  // often that position gets synced to Yjs - reading from `shapes`
  // (React state) instead would be wrong the moment sync is throttled,
  // since that state can lag several frames behind. Shapes not in
  // this map are at rest - nothing here ever touches them.
  const movingRef = useRef(new Map());
  const rafRef = useRef(null);
  const lastTimeRef = useRef(null);

  // Directly repositions a shape's own Konva node for this frame,
  // bypassing React entirely - this is what keeps local motion smooth
  // at 60fps even though the actual Yjs sync below is throttled to a
  // much lower rate. Every top-level shape node carries this same
  // "shape-node" name/id regardless of type (see Canvas.jsx's render
  // loop), which is also what the per-object export feature uses to
  // find a specific shape's node.
  //
  // Takes the shape's TOP-LEFT (x, y) - the same convention used
  // everywhere else in this file and in the shape data itself - and
  // converts it to the CENTER before calling .position(). This isn't
  // optional: every physics-eligible shape's top-level node is
  // wrapped in a rotation Group whose own x/y/offsetX/offsetY are ALL
  // set to the shape's center (see rotationGroupProps in Canvas.jsx -
  // that's the mechanism that makes rotation pivot around the middle
  // instead of the corner). Calling node.position() with raw top-left
  // coordinates on a Group set up that way doesn't move it to that
  // top-left position at all - it shifts the whole thing by roughly
  // half the shape's own width/height from where it should be, which
  // is exactly why thrown shapes were visibly drifting outside their
  // own bounding box.
  const renderNodePosition = (id, x, y, width, height) => {
    const node = stageRef?.current?.findOne(`#${id}`);
    if (!node) return;
    node.position({ x: x + width / 2, y: y + height / 2 });
    node.getLayer()?.batchDraw();
  };

  const step = useCallback((now) => {
    rafRef.current = requestAnimationFrame(step);

    if (movingRef.current.size === 0) {
      lastTimeRef.current = now;
      return;
    }

    const last = lastTimeRef.current ?? now;
    // Clamped so a backgrounded/throttled tab resuming doesn't produce
    // one huge catch-up jump in position.
    const dt = Math.min((now - last) / 1000, 0.05);
    lastTimeRef.current = now;
    if (dt <= 0) return;

    const { updateShape: doUpdate, deleteShape: doDelete } = mutatorsRef.current;
    const currentShapes = shapesRef.current;
    const byId = new Map(currentShapes.map((s) => [s.id, s]));

    // Snapshot the ids currently moving - resolveSpecialCollision
    // below can remove OTHER entries from movingRef mid-loop (a merge
    // removes one participant), so iterate a fixed list rather than
    // the live Map, and re-check aliveness per id as we go.
    const movingIds = Array.from(movingRef.current.keys());

    for (const id of movingIds) {
      const moving = movingRef.current.get(id);
      if (!moving) continue; // already resolved (merged away) earlier in this same tick

      const shapeMeta = byId.get(id);
      if (!shapeMeta) {
        // Deleted from elsewhere (e.g. another peer, or our own merge
        // logic earlier this tick) - stop simulating it. Note: byId
        // is a snapshot from the start of this tick, so a deletion
        // that happens to THIS id mid-tick via a peer's own action
        // (not ours) won't be caught until next tick - a rare,
        // accepted edge case rather than something worth chasing down
        // for a hackathon-scope feature.
        movingRef.current.delete(id);
        continue;
      }

      // Merge shapeMeta's static fields (type/width/height/color/etc,
      // which don't change from physics) with `moving`'s own tracked
      // x/y (the TRUE current position, which may be ahead of
      // whatever's last been synced to Yjs).
      const shape = { ...shapeMeta, x: moving.x, y: moving.y };

      // Attraction: pull this moving shape toward same-type SPECIAL
      // shapes within range. Deliberately one-directional (only the
      // moving shape accelerates, not both) - simpler than full
      // mutual N-body gravity, and still reads as "attraction" since
      // the thing you threw visibly curves toward its match.
      if (SPECIAL_TYPES.includes(typeOf(shape))) {
        for (const other of currentShapes) {
          if (other.id === id || typeOf(other) !== typeOf(shape)) continue;
          const dx = other.x + other.width / 2 - (shape.x + shape.width / 2);
          const dy = other.y + other.height / 2 - (shape.y + shape.height / 2);
          const dist = Math.hypot(dx, dy) || 1;
          if (dist > ATTRACT_RADIUS) continue;
          const pull = ATTRACT_ACCEL * (1 - dist / ATTRACT_RADIUS);
          moving.vx += (dx / dist) * pull * dt;
          moving.vy += (dy / dist) * pull * dt;
        }
      }

      // Air friction - exponential decay, framerate-independent.
      const decay = Math.pow(FRICTION_PER_SECOND, dt);
      moving.vx *= decay;
      moving.vy *= decay;

      const speed = Math.hypot(moving.vx, moving.vy);
      if (speed > MAX_SPEED) {
        const scale = MAX_SPEED / speed;
        moving.vx *= scale;
        moving.vy *= scale;
      }

      if (speed < STOP_SPEED) {
        // Settled - one final, unthrottled commit using the TRUE
        // tracked position (not shapeMeta's, which may be stale if
        // sync was throttled), then stop simulating this shape.
        movingRef.current.delete(id);
        doUpdate(id, { x: moving.x, y: moving.y });
        continue;
      }

      let nextX = shape.x + moving.vx * dt;
      let nextY = shape.y + moving.vy * dt;

      // Collision against every other physics-eligible shape at the
      // NEW position - simple AABB overlap, resolved by either a
      // special rule (merge/absorb/blend) or a plain bounce.
      let removedSelf = false;
      for (const other of currentShapes) {
        if (other.id === id || !isPhysicsEligible(other)) continue;
        const movedBounds = { x: nextX, y: nextY, width: shape.width, height: shape.height };
        if (!rectsOverlap(movedBounds, boundsOf(other))) continue;

        const outcome = resolveSpecialCollision(shape, other, doUpdate, doDelete);

        if (outcome === "merged-away") {
          movingRef.current.delete(id);
          removedSelf = true;
          break;
        }
        if (outcome === "merged-grew" || outcome === "absorbed-other") {
          // `other` was just deleted - stop simulating it too, in
          // case it was independently in motion from its own throw.
          movingRef.current.delete(other.id);
          continue;
        }

        // "blended" falls through to the SAME separation physics as a
        // plain bounce below (rather than a bare `continue`) - both
        // shapes survive a color blend, so without this they'd stay
        // interpenetrating and re-trigger the exact same blend again
        // on the very next frame, every frame, for as long as they
        // remain in contact. That repeated re-blending (harmless to
        // the end result, since blending an already-matching color
        // with itself is a no-op, but not free) is what caused the
        // stutter/glitch reported around sticky+sticky collisions.

        // No special rule applied (different shape types, either side
        // is an image/audio/arrow, or a "blended" pair needing
        // separation) - simple elastic-ish bounce: reflect velocity
        // along whichever axis is penetrating less, and back off so
        // the two don't stay locked overlapping.
        const overlapX =
          Math.min(movedBounds.x + movedBounds.width, other.x + other.width) - Math.max(movedBounds.x, other.x);
        const overlapY =
          Math.min(movedBounds.y + movedBounds.height, other.y + other.height) - Math.max(movedBounds.y, other.y);
        if (overlapX < overlapY) {
          moving.vx *= -BOUNCE_RESTITUTION;
          nextX += movedBounds.x < other.x ? -overlapX : overlapX;
        } else {
          moving.vy *= -BOUNCE_RESTITUTION;
          nextY += movedBounds.y < other.y ? -overlapY : overlapY;
        }
      }

      if (removedSelf) continue;

      // Update the TRUE tracked position every frame...
      moving.x = nextX;
      moving.y = nextY;

      // ...and always reposition the Konva node directly, every
      // frame, for smooth local motion regardless of sync throttling.
      renderNodePosition(id, nextX, nextY, shape.width, shape.height);

      // ...but only sync to Yjs (and therefore trigger a React
      // re-render, for everyone including this client) a few times a
      // second, not all 60. This is the actual fix for the "throwing
      // feels less smooth than before" regression: syncing on every
      // single frame meant a full board re-render (zIndex sort,
      // rotation Group wrappers on every shape, etc.) 60 times a
      // second, which got noticeably heavier as those features were
      // added on top of what was already there.
      if (now - moving.lastSyncAt >= SYNC_INTERVAL_MS) {
        moving.lastSyncAt = now;
        doUpdate(id, { x: nextX, y: nextY });
      }
    }
  }, []);

  useEffect(() => {
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [step]);

  // Hands a shape off to the physics loop with an initial velocity -
  // called from Canvas.jsx's drag-release handler when a flick is
  // detected. No-ops for anything not physics-eligible (strokes, text).
  const registerThrow = useCallback((shape, vx, vy) => {
    if (!isPhysicsEligible(shape)) return;
    movingRef.current.set(shape.id, { vx, vy, x: shape.x, y: shape.y, lastSyncAt: 0 });
  }, []);

  // Hands control of a shape back from physics to the user - called
  // when a manual drag starts on a shape that's currently mid-flight,
  // so the two systems don't fight over its position.
  const stopPhysics = useCallback((id) => {
    movingRef.current.delete(id);
  }, []);

  // One-off pulse: kicks every SPECIAL shape near `center` into
  // motion, pulling toward it (mode: "attract") or pushing away
  // (mode: "repel"). Reuses the exact same simulation loop as a
  // single throw - it's just many shapes getting an initial velocity
  // at once, not a separate system.
  const applyPulse = useCallback((center, mode) => {
    const currentShapes = shapesRef.current;
    const sign = mode === "repel" ? -1 : 1;
    const pulseRadius = ATTRACT_RADIUS * 1.5;
    for (const shape of currentShapes) {
      if (!SPECIAL_TYPES.includes(typeOf(shape))) continue;
      const cx = shape.x + shape.width / 2;
      const cy = shape.y + shape.height / 2;
      const dx = center.x - cx;
      const dy = center.y - cy;
      const dist = Math.hypot(dx, dy) || 1;
      if (dist > pulseRadius) continue;
      const strength = (1 - dist / pulseRadius) * 500;
      const existing = movingRef.current.get(shape.id);
      movingRef.current.set(shape.id, {
        vx: (existing?.vx || 0) + sign * (dx / dist) * strength,
        vy: (existing?.vy || 0) + sign * (dy / dist) * strength,
        x: existing?.x ?? shape.x,
        y: existing?.y ?? shape.y,
        lastSyncAt: existing?.lastSyncAt ?? 0,
      });
    }
  }, []);

  return { registerThrow, stopPhysics, applyPulse };
}
