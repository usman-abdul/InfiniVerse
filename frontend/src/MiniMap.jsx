import { useState } from "react";
import { getAllShapesBounds, getShapeBounds } from "./Canvas";

// Fixed panel size in screen px - a mini-map that resizes with the
// window would constantly reflow its own scale, which is more
// distracting than a small overview needs to be.
const PANEL_WIDTH = 180;
const PANEL_HEIGHT = 140;
const PANEL_PADDING = 10;
const AVATAR_RADIUS = 8;

// Cheap, stable string -> hue hash so each CONNECTION (not username)
// always gets the same color for as long as it's around. Keyed off
// clientId rather than username so two people sharing a name still
// get visibly distinct tags instead of looking like the same person.
export function colorForClientId(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return `hsl(${hash % 360}, 70%, 60%)`;
}

/**
 * Small fixed overview panel, tucked in a corner of the screen. Shows:
 *  - every shape on the board, scaled down to fit
 *  - a rectangle for our own current viewport
 *  - an avatar tag (initial + color) for every other connected user's
 *    current viewport - hover OR tap it to see their full name
 *
 * peerViewports is keyed by clientId, NOT username - two people can
 * share a name, and previously that collapsed them into a single
 * entry (only one tag ever showed for both). Each entry still carries
 * its own username for the label/tooltip, but the key and the color
 * are both tied to the underlying connection instead.
 *
 * Avatars are rendered as plain HTML (not SVG) specifically so they
 * can carry real onClick/onMouseEnter handlers and a custom-styled
 * tooltip - a native SVG <title> only responds to hover (with a
 * built-in delay, and no touch support at all), which doesn't cover
 * "click to see who this is" on a phone or tablet.
 *
 * Deliberately reuses getAllShapesBounds/getShapeBounds from Canvas.jsx
 * rather than recomputing bounding boxes a second, slightly different
 * way - same bounding-box logic that already backs export/recenter.
 */
export default function MiniMap({ shapes, ownViewport, peerViewports }) {
  // Which peer's tooltip is currently showing - set on hover, and
  // toggled (not just set) on click/tap so a touch user can tap once
  // to reveal a name and tap again (or tap elsewhere) to dismiss it.
  const [activePeerId, setActivePeerId] = useState(null);

  const shapeBounds = getAllShapesBounds(shapes);

  // The area the map needs to cover is the union of the board's own
  // content AND everyone's current viewport - otherwise someone who's
  // panned off into empty space (a very easy thing to do on an
  // infinite canvas) would just be missing from the map instead of
  // showing up as a dot out past the drawn content.
  const corners = [];
  if (shapeBounds) {
    corners.push([shapeBounds.minX, shapeBounds.minY], [shapeBounds.maxX, shapeBounds.maxY]);
  }
  const allViewports = [ownViewport, ...Object.values(peerViewports)].filter(Boolean);
  allViewports.forEach((vp) => {
    corners.push([vp.x, vp.y], [vp.x + vp.width, vp.y + vp.height]);
  });

  // Nothing to draw yet (board empty and viewport not measured on
  // first render) - rather than show an empty/misleading panel.
  if (corners.length === 0) return null;

  const minX = Math.min(...corners.map((c) => c[0]));
  const minY = Math.min(...corners.map((c) => c[1]));
  const maxX = Math.max(...corners.map((c) => c[0]));
  const maxY = Math.max(...corners.map((c) => c[1]));

  const worldWidth = Math.max(maxX - minX, 1);
  const worldHeight = Math.max(maxY - minY, 1);

  const drawableWidth = PANEL_WIDTH - PANEL_PADDING * 2;
  const drawableHeight = PANEL_HEIGHT - PANEL_PADDING * 2;
  // One uniform scale (not stretched per-axis) so shapes keep their
  // real aspect ratio on the mini-map.
  const scale = Math.min(drawableWidth / worldWidth, drawableHeight / worldHeight);

  // Centered within the panel, not pinned to a corner - a tall/narrow
  // or wide/flat board would otherwise look lopsided inside a fixed
  // panel shape.
  const offsetX = PANEL_PADDING + (drawableWidth - worldWidth * scale) / 2;
  const offsetY = PANEL_PADDING + (drawableHeight - worldHeight * scale) / 2;

  const toPanelX = (worldX) => offsetX + (worldX - minX) * scale;
  const toPanelY = (worldY) => offsetY + (worldY - minY) * scale;

  // Raw (possibly overlapping) panel position for every peer.
  const rawPeerPositions = Object.entries(peerViewports).map(([id, peer]) => ({
    id,
    username: peer.username,
    cx: toPanelX(peer.x + peer.width / 2),
    cy: toPanelY(peer.y + peer.height / 2),
  }));

  // Two peers who haven't panned away from the same starting view (or
  // are just genuinely looking at the same spot) land on the exact
  // same panel pixel - and since these are opaque circles drawn in
  // order, the later one draws directly on top of the earlier one,
  // making it look like only one person is here even though the count
  // is correct. Cluster anyone within occlusion distance of each
  // other and fan them out around their shared point instead, the
  // same way map pins handle overlapping markers.
  const OVERLAP_DISTANCE = AVATAR_RADIUS * 1.8;
  const placedPeers = [];
  const consumed = new Set();
  rawPeerPositions.forEach((peer, i) => {
    if (consumed.has(peer.id)) return;
    const group = [peer];
    consumed.add(peer.id);
    for (let j = i + 1; j < rawPeerPositions.length; j++) {
      const other = rawPeerPositions[j];
      if (consumed.has(other.id)) continue;
      const dx = other.cx - peer.cx;
      const dy = other.cy - peer.cy;
      if (Math.sqrt(dx * dx + dy * dy) < OVERLAP_DISTANCE) {
        group.push(other);
        consumed.add(other.id);
      }
    }
    if (group.length === 1) {
      placedPeers.push(group[0]);
      return;
    }
    const fanRadius = AVATAR_RADIUS * 1.15;
    group.forEach((member, idx) => {
      const angle = (idx / group.length) * Math.PI * 2 - Math.PI / 2;
      placedPeers.push({
        ...member,
        cx: member.cx + Math.cos(angle) * fanRadius,
        cy: member.cy + Math.sin(angle) * fanRadius,
      });
    });
  });

  const hasPeers = Object.keys(peerViewports).length > 0;

  return (
    <div className={`minimap ${hasPeers ? "" : "solo"}`}>
      <div className="minimap-surface">
        <svg width={PANEL_WIDTH} height={PANEL_HEIGHT} viewBox={`0 0 ${PANEL_WIDTH} ${PANEL_HEIGHT}`}>
          <rect x={0} y={0} width={PANEL_WIDTH} height={PANEL_HEIGHT} rx={10} className="minimap-bg" />

          {shapes.map((shape) => {
            const bounds = getShapeBounds(shape);
            const x = toPanelX(bounds.x);
            const y = toPanelY(bounds.y);
            const w = Math.max(bounds.width * scale, 1.5);
            const h = Math.max(bounds.height * scale, 1.5);
            return <rect key={shape.id} x={x} y={y} width={w} height={h} className="minimap-shape" />;
          })}

          {ownViewport && (
            <rect
              x={toPanelX(ownViewport.x)}
              y={toPanelY(ownViewport.y)}
              width={Math.max(ownViewport.width * scale, 2)}
              height={Math.max(ownViewport.height * scale, 2)}
              className="minimap-own-viewport"
            />
          )}
        </svg>

        <div className="minimap-peers">
          {placedPeers.map((peer) => {
            const color = colorForClientId(peer.id);
            const initial = (peer.username || "?").trim().charAt(0).toUpperCase() || "?";
            const isActive = activePeerId === peer.id;
            return (
              <div
                key={peer.id}
                className="minimap-peer-avatar"
                style={{
                  left: peer.cx - AVATAR_RADIUS,
                  top: peer.cy - AVATAR_RADIUS,
                  width: AVATAR_RADIUS * 2,
                  height: AVATAR_RADIUS * 2,
                  background: color,
                }}
                onMouseEnter={() => setActivePeerId(peer.id)}
                onMouseLeave={() => setActivePeerId((current) => (current === peer.id ? null : current))}
                onClick={() => setActivePeerId((current) => (current === peer.id ? null : peer.id))}
              >
                {initial}
                {isActive && <div className="minimap-peer-tooltip">{peer.username}</div>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
