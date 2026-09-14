import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Stage, Layer, Line, Rect, Ellipse, Text, Group, Arrow, Image as KonvaImage } from "react-konva";
import Konva from "konva";
import { useHtmlImage } from "./useHtmlImage";
import { uploadAudio } from "./api";
import { usePhysics } from "./usePhysics";
import StylePanel from "./StylePanel";

const MIN_SCALE = 0.1;
const MAX_SCALE = 4;
const DEFAULT_COLOR = "#2B2B2E";
const HEADER_HEIGHT = 56;
const HIT_PADDING = 8; // world units of slack around thin shapes, so a stroke/line is easy to click
const STICKY_SIZE = 180;
const STICKY_PADDING = 14;
const STICKY_FONT_SIZE = 16;
const STICKY_COLOR = "#FFE9A8";
const STICKY_COLORS = ["#FFE9A8", "#B8E1FF", "#C8F7C5", "#FFC9DE", "#E5D4FF"];
const AUDIO_CHIP_SIZE = 56;
const CLICK_VS_DRAG_THRESHOLD = 4; // world units - below this, a pointer-down+up counts as a click, not a drag
// Deliberately excludes "arrow": its width/height are signed (they
// encode direction - see the drafting logic below), but the generic
// resize-handle logic normalizes width/height to positive values,
// which would silently flatten every arrow to point the same
// down-right diagonal after a resize. Arrows can still be moved like
// any other shape; to change length/direction, redraw it.
const RESIZABLE_TYPES = ["rect", "ellipse", "sticky", "image", "triangle", "star"];
const THROW_VELOCITY_SAMPLES = 5; // how many recent pointer positions to keep for the release-velocity estimate
const THROW_MIN_SPEED = 250; // world units/sec - a release below this is a deliberate placement, not a flick

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

let measureCtx = null;
function measureTextWidth(text, fontSize) {
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  measureCtx.font = `${fontSize}px Inter, system-ui, sans-serif`;
  return Math.max(1, ...text.split("\n").map((line) => measureCtx.measureText(line).width));
}

// Point arrays for the box-fit shapes below, shared across the live
// canvas, the draft (in-progress) preview, the SVG export, and
// Time-Travel's replay renderer - one source of truth for "what does
// a triangle/star inscribed in this x/y/width/height box look like."
export function trianglePoints(x, y, width, height) {
  return [x + width / 2, y, x, y + height, x + width, y + height];
}

export function starPoints(x, y, width, height) {
  const cx = x + width / 2;
  const cy = y + height / 2;
  const outerRx = width / 2;
  const outerRy = height / 2;
  const innerRx = outerRx * 0.4;
  const innerRy = outerRy * 0.4;
  const points = [];
  for (let i = 0; i < 10; i++) {
    const angle = (Math.PI / 5) * i - Math.PI / 2;
    const rx = i % 2 === 0 ? outerRx : innerRx;
    const ry = i % 2 === 0 ? outerRy : innerRy;
    points.push(cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry);
  }
  return points;
}

// Largest axis-aligned rectangle that fits inside an ellipse of the
// given width/height, centered - used so a sticky note's text doesn't
// overflow past the curve once it's "taken" an ellipse outline (see
// usePhysics.js's absorb rule). A plain corner-padding inset, like the
// rectangular sticky uses, would let the text box's square corners
// poke outside the ellipse's rounded sides.
// Konva combines bold/italic into one space-separated fontStyle
// string (e.g. "italic bold") rather than two separate props -
// small helper so every text-rendering branch doesn't repeat this.
export function konvaFontStyle(shape) {
  const parts = [];
  if (shape.italic) parts.push("italic");
  if (shape.bold) parts.push("bold");
  return parts.length > 0 ? parts.join(" ") : "normal";
}

export function ellipseInscribedBox(x, y, width, height) {
  const inscribedWidth = width / Math.SQRT2;
  const inscribedHeight = height / Math.SQRT2;
  return {
    x: x + (width - inscribedWidth) / 2,
    y: y + (height - inscribedHeight) / 2,
    width: inscribedWidth,
    height: inscribedHeight,
  };
}

// Approximate usable text areas for triangle/star-shaped stickies -
// not a mathematically exact largest-inscribed-rectangle (that's a
// much harder problem for a general triangle/star than the ellipse
// case above), just a reasonable, good-enough box that stays clear of
// the slanted/pointed edges.
export function triangleInscribedBox(x, y, width, height) {
  // The triangle drawn by trianglePoints is widest at the bottom -
  // text sits in that lower band, inset well away from the two
  // slanted sides.
  const insetX = width * 0.28;
  const boxHeight = height * 0.38;
  return {
    x: x + insetX,
    y: y + height - boxHeight - height * 0.1,
    width: width - insetX * 2,
    height: boxHeight,
  };
}

export function starInscribedBox(x, y, width, height) {
  // A star's own "safe" interior (clear of all five points) is
  // smaller than an ellipse's - a centered box inset well past where
  // the inner points sit.
  const inset = 0.32;
  return {
    x: x + width * inset,
    y: y + height * inset,
    width: width * (1 - inset * 2),
    height: height * (1 - inset * 2),
  };
}

// Picks the right text box for a sticky note based on whatever
// outline it's currently using (see usePhysics.js's absorb rule) -
// one shared decision point reused by the live canvas, SVG export,
// and Time Travel replay, so the four possible outlines (rect is the
// default/fallback) can never drift out of sync between them.
export function stickyTextBox(shape) {
  const kind = shape.shapeKind || "rect";
  if (kind === "ellipse") return ellipseInscribedBox(shape.x, shape.y, shape.width, shape.height);
  if (kind === "triangle") return triangleInscribedBox(shape.x, shape.y, shape.width, shape.height);
  if (kind === "star") return starInscribedBox(shape.x, shape.y, shape.width, shape.height);
  return {
    x: shape.x + STICKY_PADDING,
    y: shape.y + STICKY_PADDING,
    width: shape.width - STICKY_PADDING * 2,
    height: shape.height - STICKY_PADDING * 2,
  };
}

// Konva rotates a node around its own x/y position, so to rotate a
// shape around its CENTER (not its top-left corner) rather than
// rewriting every shape's own coordinate system, wrap it in a Group
// whose x/y AND offsetX/offsetY both sit at the shape's center - the
// translate-to-center and translate-back cancel out when rotation is
// 0, so an unrotated shape renders exactly as it did before this
// existed. Rotation is deliberately visual-only: hit-testing,
// dragging, resizing, and physics collision all still use the
// un-rotated bounding box (see getShapeBounds just below) - a real
// rotated-AABB implementation would touch a lot more of the app for
// a "cheap win" feature, so a heavily-rotated shape's clickable area
// may not perfectly match what's drawn. That's a deliberate,
// documented trade-off, not an oversight.
export function rotationGroupProps(shape) {
  const cx = shape.x + shape.width / 2;
  const cy = shape.y + shape.height / 2;
  return { x: cx, y: cy, offsetX: cx, offsetY: cy, rotation: shape.rotation || 0 };
}

export function getShapeBounds(shape) {
  const type = shape.type || "stroke";
  if (
    type === "rect" ||
    type === "ellipse" ||
    type === "image" ||
    type === "sticky" ||
    type === "audio" ||
    type === "triangle" ||
    type === "star"
  ) {
    return { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
  }
  if (type === "arrow") {
    // Unlike every other box-shape here, an arrow's width/height can
    // be negative - that's what lets it point back-up-and-left
    // instead of only ever down-and-right (see the drafting logic
    // below). Every OTHER consumer of bounds (hit-testing, physics,
    // export, mini-map) needs a normal non-negative box though, so
    // normalize here rather than leaking signed values outward.
    return {
      x: Math.min(shape.x, shape.x + shape.width),
      y: Math.min(shape.y, shape.y + shape.height),
      width: Math.abs(shape.width),
      height: Math.abs(shape.height),
    };
  }
  if (type === "text") {
    const width = measureTextWidth(shape.text, shape.fontSize);
    const lines = shape.text.split("\n").length;
    return { x: shape.x, y: shape.y, width, height: shape.fontSize * 1.3 * lines };
  }
  const xs = shape.points.filter((_, i) => i % 2 === 0);
  const ys = shape.points.filter((_, i) => i % 2 === 1);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

const EXPORT_PADDING = 40; // world units of breathing room around the full board in exports

// Bounding box of every shape combined - the "whole board," regardless
// of what's currently panned into view. Used by both PNG and SVG
// export so neither one crops out shapes sitting off-screen.
export function getAllShapesBounds(shapes) {
  if (shapes.length === 0) return null;
  const boundsList = shapes.map(getShapeBounds);
  const minX = Math.min(...boundsList.map((b) => b.x));
  const minY = Math.min(...boundsList.map((b) => b.y));
  const maxX = Math.max(...boundsList.map((b) => b.x + b.width));
  const maxY = Math.max(...boundsList.map((b) => b.y + b.height));
  return { minX, minY, maxX, maxY };
}

function escapeXML(str) {
  return String(str).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}

// SVG has no "rotate around a shape's own center" primitive the way
// Konva's Group offset trick provides - rotate(angle, cx, cy) is the
// direct equivalent, using the EXPORT-LOCAL x/y (already offset by
// minX/minY) rather than the shape's raw world coordinates.
function svgRotateAttr(shape, x, y) {
  const rotation = shape.rotation || 0;
  if (!rotation) return "";
  const cx = x + shape.width / 2;
  const cy = y + shape.height / 2;
  return ` transform="rotate(${rotation} ${cx} ${cy})"`;
}

// SVG's font-weight/font-style are separate attributes, unlike
// Konva's combined fontStyle string (see konvaFontStyle above).
function svgFontAttrs(shape) {
  const weight = shape.bold ? ` font-weight="bold"` : "";
  const style = shape.italic ? ` font-style="italic"` : "";
  return `${weight}${style}`;
}

// Hand-written, not a library - Konva itself has no built-in SVG
// export. Since our shape model only has six simple types, mapping
// each one to a plain SVG element directly is cheap and keeps this
// fully independent of the canvas rendering path (so exporting works
// even for shapes currently scrolled off-screen).
function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function shapesToSVG(shapes) {
  const bounds = getAllShapesBounds(shapes);
  const minX = bounds ? bounds.minX - EXPORT_PADDING : 0;
  const minY = bounds ? bounds.minY - EXPORT_PADDING : 0;
  const width = bounds ? Math.ceil(bounds.maxX - bounds.minX + EXPORT_PADDING * 2) : 400;
  const height = bounds ? Math.ceil(bounds.maxY - bounds.minY + EXPORT_PADDING * 2) : 300;

  // Images are fetched and converted to base64 data URIs up front, in
  // parallel, so the finished SVG is fully self-contained - a plain
  // <image href="..."> pointing back at the backend would break the
  // moment the file is opened somewhere that address isn't reachable
  // (a different computer, backend not running, months from now).
  // This is the only genuinely async part of an otherwise synchronous
  // serialization, which is why the whole function is async.
  const imageDataUrls = {};
  await Promise.all(
    shapes
      .filter((s) => s.type === "image")
      .map(async (shape) => {
        try {
          const response = await fetch(shape.url);
          const blob = await response.blob();
          imageDataUrls[shape.id] = await blobToDataURL(blob);
        } catch {
          // Fetch failed (backend down, image deleted, etc.) - falls
          // back to the raw URL below rather than dropping the image
          // from the export entirely.
          imageDataUrls[shape.id] = null;
        }
      })
  );

  const orderedShapes = [...shapes].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));

  const parts = orderedShapes.map((shape) => {
    const type = shape.type || "stroke";
    const x = shape.x - minX;
    const y = shape.y - minY;

    if (type === "stroke") {
      const points = [];
      for (let i = 0; i < shape.points.length; i += 2) {
        points.push(`${shape.points[i] - minX},${shape.points[i + 1] - minY}`);
      }
      return `<polyline points="${points.join(" ")}" fill="none" stroke="${shape.color}" stroke-width="${shape.strokeWidth}" stroke-linecap="round" stroke-linejoin="round" />`;
    }
    if (type === "rect") {
      return `<rect x="${x}" y="${y}" width="${shape.width}" height="${shape.height}" fill="none" stroke="${shape.color}" stroke-width="${shape.strokeWidth || 2}"${svgRotateAttr(shape, x, y)} />`;
    }
    if (type === "ellipse") {
      return `<ellipse cx="${x + shape.width / 2}" cy="${y + shape.height / 2}" rx="${shape.width / 2}" ry="${shape.height / 2}" fill="none" stroke="${shape.color}" stroke-width="${shape.strokeWidth || 2}"${svgRotateAttr(shape, x, y)} />`;
    }
    if (type === "triangle") {
      const points = trianglePoints(x, y, shape.width, shape.height).join(",");
      return `<polygon points="${points}" fill="none" stroke="${shape.color}" stroke-width="${shape.strokeWidth || 2}"${svgRotateAttr(shape, x, y)} />`;
    }
    if (type === "star") {
      const points = starPoints(x, y, shape.width, shape.height).join(",");
      return `<polygon points="${points}" fill="none" stroke="${shape.color}" stroke-width="${shape.strokeWidth || 2}"${svgRotateAttr(shape, x, y)} />`;
    }
    if (type === "arrow") {
      const x2 = x + shape.width;
      const y2 = y + shape.height;
      const angle = Math.atan2(y2 - y, x2 - x);
      const headLength = 14;
      const headAngle = Math.PI / 7; // ~25.7deg half-angle - matches Konva's Arrow proportions closely enough
      const hx1 = x2 - headLength * Math.cos(angle - headAngle);
      const hy1 = y2 - headLength * Math.sin(angle - headAngle);
      const hx2 = x2 - headLength * Math.cos(angle + headAngle);
      const hy2 = y2 - headLength * Math.sin(angle + headAngle);
      return `<g${svgRotateAttr(shape, x, y)}><line x1="${x}" y1="${y}" x2="${x2}" y2="${y2}" stroke="${shape.color}" stroke-width="${shape.strokeWidth || 2}" /><polygon points="${x2},${y2} ${hx1},${hy1} ${hx2},${hy2}" fill="${shape.color}" /></g>`;
    }
    if (type === "text") {
      const lines = shape.text.split("\n");
      const tspans = lines
        .map((line, i) => `<tspan x="${x}" dy="${i === 0 ? shape.fontSize : shape.fontSize * 1.3}">${escapeXML(line)}</tspan>`)
        .join("");
      const fontFamily = shape.fontFamily || "Inter, sans-serif";
      return `<text y="${y + shape.fontSize}" font-family="${escapeXML(fontFamily)}" font-size="${shape.fontSize}"${svgFontAttrs(shape)} fill="${shape.color}">${tspans}</text>`;
    }
    if (type === "sticky") {
      const lines = shape.text.split("\n");
      const stickyKind = shape.shapeKind || "rect";
      const textBox = stickyTextBox({ ...shape, x, y });
      const textAnchor = shape.align === "center" ? "middle" : shape.align === "right" ? "end" : "start";
      const tspanX = shape.align === "center" ? textBox.x + textBox.width / 2 : shape.align === "right" ? textBox.x + textBox.width : textBox.x;
      const tspans = lines
        .map(
          (line, i) =>
            `<tspan x="${tspanX}" dy="${i === 0 ? shape.fontSize : shape.fontSize * 1.3}">${escapeXML(line)}</tspan>`
        )
        .join("");
      const background =
        stickyKind === "ellipse"
          ? `<ellipse cx="${x + shape.width / 2}" cy="${y + shape.height / 2}" rx="${shape.width / 2}" ry="${shape.height / 2}" fill="${shape.color}" />`
          : stickyKind === "triangle"
          ? `<polygon points="${trianglePoints(x, y, shape.width, shape.height).join(",")}" fill="${shape.color}" />`
          : stickyKind === "star"
          ? `<polygon points="${starPoints(x, y, shape.width, shape.height).join(",")}" fill="${shape.color}" />`
          : `<rect x="${x}" y="${y}" width="${shape.width}" height="${shape.height}" rx="4" fill="${shape.color}" />`;
      const fontFamily = shape.fontFamily || "Inter, sans-serif";
      return `<g${svgRotateAttr(shape, x, y)}>${background}<text x="${tspanX}" y="${textBox.y + shape.fontSize}" text-anchor="${textAnchor}" font-family="${escapeXML(fontFamily)}" font-size="${shape.fontSize}"${svgFontAttrs(shape)} fill="${DEFAULT_COLOR}">${tspans}</text></g>`;
    }
    if (type === "image") {
      const href = imageDataUrls[shape.id] || shape.url;
      return `<image href="${escapeXML(href)}" x="${x}" y="${y}" width="${shape.width}" height="${shape.height}"${svgRotateAttr(shape, x, y)} />`;
    }
    if (type === "audio") {
      // A static SVG obviously can't play audio - this is just a
      // visual marker showing where a clip sits on the board.
      const cx = x + shape.width / 2;
      const cy = y + shape.height / 2;
      return `<g><circle cx="${cx}" cy="${cy}" r="${shape.width / 2}" fill="#fff" stroke="${DEFAULT_COLOR}" stroke-width="1.5" /><polygon points="${cx - 6},${cy - 8} ${cx - 6},${cy + 8} ${cx + 9},${cy}" fill="${DEFAULT_COLOR}" /></g>`;
    }
    return "";
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="100%" height="100%" fill="#FAFAF8" />`,
    ...parts,
    `</svg>`,
  ].join("\n");
}

function pointInBounds(point, bounds) {
  return (
    point.x >= bounds.x - HIT_PADDING &&
    point.x <= bounds.x + bounds.width + HIT_PADDING &&
    point.y >= bounds.y - HIT_PADDING &&
    point.y <= bounds.y + bounds.height + HIT_PADDING
  );
}

function hitTest(shapes, world, { onlyType, predicate } = {}) {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const shape = shapes[i];
    const type = shape.type || "stroke";
    if (onlyType && type !== onlyType) continue;
    if (predicate && !predicate(shape)) continue;
    if (pointInBounds(world, getShapeBounds(shape))) return shape;
  }
  return null;
}

const Canvas = forwardRef(function Canvas(
  {
    shapes,
    addShape,
    updateShape,
    deleteShape,
    username,
    tool,
    roomId,
    onUploadError,
    onDownloadImages,
    onViewportChange,
  },
  ref
) {
  const [currentPoints, setCurrentPoints] = useState(null);
  const [draftShape, setDraftShape] = useState(null);
  const [stagePos, setStagePos] = useState({ x: 0, y: 0 });
  const [stageScale, setStageScale] = useState(1);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  // True only once a grabbed shape has actually moved past
  // CLICK_VS_DRAG_THRESHOLD - not the instant it's grabbed. A plain
  // click-to-select should still show the style panel immediately;
  // only a genuine drag (in particular, throwing something) should
  // hide it, since that's when it's most likely to sit right on top
  // of whatever you're trying to look at while moving it.
  const [isActivelyDragging, setIsActivelyDragging] = useState(false);
  const [editingText, setEditingText] = useState(null);
  // { x, y } in world coords while a recording is in progress at that
  // spot - purely for the overlay pill's position, not authoritative
  // data (recorderRef below holds the actual MediaRecorder state).
  const [recording, setRecording] = useState(null);
  const [recordingElapsedMs, setRecordingElapsedMs] = useState(0);
  const [playingId, setPlayingId] = useState(null);
  // Ids of images Shift+clicked for bulk download - deliberately
  // separate from selectedId (which drives drag/resize/delete for one
  // shape at a time) so this doesn't disturb any of that existing
  // behavior. One mechanism covers both "download just this one" and
  // "download several" - Shift+click a single image, or several.
  const [pickedForDownload, setPickedForDownload] = useState(new Set());
  // Read fresh on every resize/orientation-change instead of once at
  // mount - otherwise the canvas keeps whatever size the window
  // happened to be on first load, and never adjusts (rotating a phone,
  // resizing a browser window, or the mobile address bar
  // showing/hiding all leave it wrong without this).
  const [viewportSize, setViewportSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight - HEADER_HEIGHT,
  }));

  const isDrawing = useRef(false);
  const isPanning = useRef(false);
  const draggingRef = useRef(null); // { id, startShape, startWorld } while dragging a shape
  const resizingRef = useRef(null); // { id, startBounds, startWorld } while dragging the corner resize handle
  const dragStartWorld = useRef({ x: 0, y: 0 });
  const lastPointerScreen = useRef({ x: 0, y: 0 });
  const stageRef = useRef(null);
  const textareaRef = useRef(null);
  const recorderRef = useRef(null); // { mediaRecorder, chunks, stream, x, y, startedAt } while recording
  const audioElementsRef = useRef({}); // shape.id -> HTMLAudioElement, created lazily on first playback
  // Rolling buffer of { x, y, t } samples taken during a shape drag -
  // used on release to estimate how fast the pointer was moving, so a
  // fast "flick" can be handed off to physics as a throw while a slow,
  // deliberate placement behaves exactly as it always has. See
  // usePhysics.js for what happens after a shape is thrown.
  const dragVelocitySamplesRef = useRef([]);

  const { registerThrow, stopPhysics, applyPulse } = usePhysics({ shapes, updateShape, deleteShape, stageRef });

  const screenToWorld = (screenPos) => ({
    x: (screenPos.x - stagePos.x) / stageScale,
    y: (screenPos.y - stagePos.y) / stageScale,
  });

  // Shared by both the whole-board PNG export and "export just this
  // one object" - temporarily reposition/resize the SAME Konva Stage
  // already on screen to exactly frame the given bounds, snapshot it,
  // then restore the real viewport state immediately after. Done
  // through direct Konva node calls (not React state), so none of
  // this ever triggers a visible re-render of the live canvas - it
  // all happens synchronously in one call.
  //
  // When onlyShapeId is given, every OTHER shape's node is also
  // hidden for the snapshot (found via the "shape-node" name every
  // top-level shape carries regardless of type - see the render loop
  // below), so an "export just this shape" action doesn't leak
  // whatever else happens to overlap it into what's supposed to be
  // an isolated image.
  const renderStagePNG = (bounds, onlyShapeId) => {
    const stage = stageRef.current;
    if (!stage || !bounds) return null;

    const exportWidth = Math.ceil(bounds.maxX - bounds.minX + EXPORT_PADDING * 2);
    const exportHeight = Math.ceil(bounds.maxY - bounds.minY + EXPORT_PADDING * 2);

    const prevScale = stage.scaleX();
    const prevX = stage.x();
    const prevY = stage.y();
    const prevWidth = stage.width();
    const prevHeight = stage.height();

    // Hide selection outline/resize-handle chrome for the snapshot -
    // that's an editing affordance, not actual board content.
    const hiddenChromeNodes = stage.find(".export-hide");
    hiddenChromeNodes.forEach((node) => node.hide());

    const hiddenSiblingNodes = onlyShapeId
      ? stage.find(".shape-node").filter((node) => node.id() !== onlyShapeId)
      : [];
    hiddenSiblingNodes.forEach((node) => node.hide());

    // The cream background seen during normal use is just CSS on
    // the page around the canvas - it was never actually part of
    // the Konva canvas's own pixels, so without this, toDataURL()
    // exports a fully transparent PNG (which shows as black/dark or
    // checkered depending on whatever opens it afterward). Added as
    // a real Konva node, temporarily, so it's baked into the actual
    // exported pixels rather than just visually implied on-screen.
    const layer = stage.getLayers()[0];
    const backgroundRect = new Konva.Rect({
      x: bounds.minX - EXPORT_PADDING,
      y: bounds.minY - EXPORT_PADDING,
      width: exportWidth,
      height: exportHeight,
      fill: "#FAFAF8",
      listening: false,
    });
    layer.add(backgroundRect);
    backgroundRect.moveToBottom();

    stage.scale({ x: 1, y: 1 });
    stage.position({ x: -(bounds.minX - EXPORT_PADDING), y: -(bounds.minY - EXPORT_PADDING) });
    stage.width(exportWidth);
    stage.height(exportHeight);
    stage.batchDraw();

    const dataUrl = stage.toDataURL({ pixelRatio: 2, mimeType: "image/png" });

    backgroundRect.destroy();
    hiddenChromeNodes.forEach((node) => node.show());
    hiddenSiblingNodes.forEach((node) => node.show());
    stage.scale({ x: prevScale, y: prevScale });
    stage.position({ x: prevX, y: prevY });
    stage.width(prevWidth);
    stage.height(prevHeight);
    stage.batchDraw();

    return dataUrl;
  };

  useImperativeHandle(ref, () => ({
    getViewportCenterWorld: () =>
      screenToWorld({ x: viewportSize.width / 2, y: viewportSize.height / 2 }),

    // Applies an attract/repel pulse centered on whatever's currently
    // in view - same "acts on what you're looking at" spirit as
    // Recenter, rather than requiring a separate click-to-target step.
    attractPulse: () => {
      applyPulse(screenToWorld({ x: viewportSize.width / 2, y: viewportSize.height / 2 }), "attract");
    },
    repelPulse: () => {
      applyPulse(screenToWorld({ x: viewportSize.width / 2, y: viewportSize.height / 2 }), "repel");
    },

    // "I've panned off into empty space and lost my drawing" is an
    // easy thing to do on a genuinely infinite canvas - this snaps
    // back to a sane view: fit all current content into the viewport
    // if there's anything on the board, or just re-center on the
    // origin at 1x zoom if the board is empty.
    recenterView: () => {
      const bounds = getAllShapesBounds(shapes);
      if (!bounds) {
        setStageScale(1);
        setStagePos({ x: viewportSize.width / 2, y: viewportSize.height / 2 });
        return;
      }

      const RECENTER_PADDING = 80; // px of on-screen breathing room around the fitted content
      const contentWidth = Math.max(bounds.maxX - bounds.minX, 1);
      const contentHeight = Math.max(bounds.maxY - bounds.minY, 1);
      const fitScale = Math.min(
        (viewportSize.width - RECENTER_PADDING * 2) / contentWidth,
        (viewportSize.height - RECENTER_PADDING * 2) / contentHeight
      );
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, fitScale));

      const centerX = (bounds.minX + bounds.maxX) / 2;
      const centerY = (bounds.minY + bounds.maxY) / 2;

      setStageScale(newScale);
      setStagePos({
        x: viewportSize.width / 2 - centerX * newScale,
        y: viewportSize.height / 2 - centerY * newScale,
      });
    },

    exportSVG: () => shapesToSVG(shapes),

    // Full-board PNG (including shapes currently panned off-screen).
    // See renderStagePNG above for how this actually works.
    exportPNG: () => {
      const bounds = getAllShapesBounds(shapes);
      if (!bounds) {
        console.warn(`exportPNG: nothing to export (shapes count: ${shapes.length})`);
        return null;
      }
      return renderStagePNG(bounds);
    },
  }));

  useEffect(() => {
    const onResize = () => {
      setViewportSize({ width: window.innerWidth, height: window.innerHeight - HEADER_HEIGHT });
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);

  // Reports our current world-space viewport rect up to Room.jsx
  // whenever panning, zooming, or resizing changes it - purely local
  // computation, cheap enough to run untouched on every change. Room
  // owns deciding how often that actually gets broadcast over the
  // socket (see its handleViewportChange), this effect just always
  // keeps the caller's copy current for local mini-map rendering.
  useEffect(() => {
    if (!onViewportChange) return;
    onViewportChange({
      x: -stagePos.x / stageScale,
      y: -stagePos.y / stageScale,
      width: viewportSize.width / stageScale,
      height: viewportSize.height / stageScale,
    });
  }, [stagePos, stageScale, viewportSize, onViewportChange]);

  // Focus (and select-all, so typing over existing text replaces it)
  // exactly once when a new editing session opens - NOT on every
  // keystroke. editingText gets a new object identity on every
  // keystroke (see commitTextEdit/onChange below), so depending on the
  // object itself here would re-select-all after each character,
  // wiping out everything but the last key pressed.
  const hasFocusedSession = useRef(false);
  useEffect(() => {
    if (!editingText) {
      hasFocusedSession.current = false;
      return;
    }
    if (!hasFocusedSession.current && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
      hasFocusedSession.current = true;
    }
  }, [editingText]);

  const deleteSelected = () => {
    if (!selectedId) return;
    // There's no undo yet, so a stray Delete/Backspace (or an
    // accidental panel click) would be an irreversible mistake
    // without this. A plain confirm() is a deliberate MVP shortcut
    // here - worth swapping for an Undo (Ctrl+Z) pattern later if
    // there's time, since that's less disruptive to a fast workflow
    // than a blocking dialog on every single delete.
    if (window.confirm("Delete this?")) {
      deleteShape(selectedId);
    }
    setSelectedId(null);
  };

  // Layer order is just a plain numeric field (zIndex), sorted at
  // render time (see orderedShapes below) - shapes without one
  // default to 0 and keep their natural creation-order position. A
  // small chance two people click "bring to front" on two different
  // shapes at the exact same instant and compute the same new max+1
  // is an accepted, harmless edge case (both just end up near the
  // top; nothing breaks) rather than something worth a real
  // conflict-resolution scheme for.
  const bringSelectedToFront = () => {
    if (!selectedId) return;
    const maxZ = Math.max(0, ...shapes.map((s) => s.zIndex ?? 0));
    updateShape(selectedId, { zIndex: maxZ + 1 });
  };

  const sendSelectedToBack = () => {
    if (!selectedId) return;
    const minZ = Math.min(0, ...shapes.map((s) => s.zIndex ?? 0));
    updateShape(selectedId, { zIndex: minZ - 1 });
  };

  // Clones the selected shape with a small offset so the copy is
  // visibly distinct from the original, and brought to the front so
  // it's not hidden behind whatever it was copied from. Generic
  // across every shape type via a spread - EXCEPT strokes, which
  // don't have a single x/y field to offset (their geometry lives
  // entirely in the points array), so they need their points shifted
  // instead.
  const duplicateSelected = () => {
    if (!selectedShape) return;
    const OFFSET = 24;
    const maxZ = Math.max(0, ...shapes.map((s) => s.zIndex ?? 0));
    const newId = newShapeId();
    if ((selectedShape.type || "stroke") === "stroke") {
      const points = selectedShape.points.map((v) => v + OFFSET);
      addShape({ ...selectedShape, id: newId, points, zIndex: maxZ + 1 });
    } else {
      addShape({
        ...selectedShape,
        id: newId,
        x: selectedShape.x + OFFSET,
        y: selectedShape.y + OFFSET,
        zIndex: maxZ + 1,
      });
    }
    setSelectedId(newId);
  };

  // Tiny local download helpers - Room.jsx has its own copies of the
  // same two functions for the whole-board export menu, but per-shape
  // export lives entirely in Canvas.jsx (this is where selectedShape
  // and stageRef already are), so duplicating ~10 lines here is
  // simpler than threading callbacks up through Room.jsx for no
  // other reason than avoiding a small repeat.
  const downloadDataUrl = (url, filename) => {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
  };

  const downloadBlobFile = (content, mimeType, filename) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    downloadDataUrl(url, filename);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // Exports just the SELECTED shape, not the whole board - reuses
  // the exact same renderStagePNG technique the whole-board export
  // uses (reposition the stage to frame specific bounds), just with
  // getShapeBounds(selectedShape) instead of getAllShapesBounds(shapes),
  // and passing selectedShape.id so every OTHER shape gets hidden for
  // the snapshot. Deliberately NOT a bare node.toDataURL() call -
  // Konva Groups (which is what almost every shape is now, due to the
  // rotation wrapper - see rotationGroupProps) have no intrinsic
  // width/height the way Rect/Image do, so that would likely produce
  // a blank or wrongly-cropped image for most shape types here.
  const exportSelectedPNG = () => {
    if (!selectedShape) return;
    const shapeBounds = getShapeBounds(selectedShape);
    // Normalize {x, y, width, height} into the {minX, minY, maxX,
    // maxY} shape renderStagePNG expects - the same convention
    // getAllShapesBounds already uses.
    const bounds = {
      minX: shapeBounds.x,
      minY: shapeBounds.y,
      maxX: shapeBounds.x + shapeBounds.width,
      maxY: shapeBounds.y + shapeBounds.height,
    };
    const dataUrl = renderStagePNG(bounds, selectedShape.id);
    if (!dataUrl) return;
    downloadDataUrl(dataUrl, `infiniverse-${selectedShape.type || "shape"}.png`);
  };

  // Reuses shapesToSVG (the whole-board export's own serializer) with
  // a single-shape array - it already computes bounds/cropping/offset
  // generically for whatever shapes it's given, so a one-shape array
  // produces a tightly-cropped single-shape SVG for free, no separate
  // per-shape SVG logic needed.
  const exportSelectedSVG = async () => {
    if (!selectedShape) return;
    const svg = await shapesToSVG([selectedShape]);
    downloadBlobFile(svg, "image/svg+xml", `infiniverse-${selectedShape.type || "shape"}.svg`);
  };

  const exportSelectedJSON = () => {
    if (!selectedShape) return;
    downloadBlobFile(
      JSON.stringify(selectedShape, null, 2),
      "application/json",
      `infiniverse-${selectedShape.type || "shape"}.json`
    );
  };

  useEffect(() => {
    const isTypingTarget = () => {
      const tag = document.activeElement?.tagName;
      return tag === "INPUT" || tag === "TEXTAREA";
    };
    const onKeyDown = (e) => {
      if (e.code === "Space" && !isTypingTarget()) {
        e.preventDefault();
        setSpaceHeld(true);
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && !isTypingTarget()) {
        if (selectedId) {
          e.preventDefault();
          deleteSelected();
        }
      }
      if (e.key === "Escape" && !isTypingTarget() && pickedForDownload.size > 0) {
        setPickedForDownload(new Set());
      }
    };
    const onKeyUp = (e) => {
      if (e.code !== "Space") return;
      setSpaceHeld(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [tool, selectedId, deleteShape, pickedForDownload]);

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => {
      if (recorderRef.current) setRecordingElapsedMs(Date.now() - recorderRef.current.startedAt);
    }, 200);
    return () => clearInterval(id);
  }, [recording]);

  const prevToolRef = useRef(tool);
  useEffect(() => {
    if (prevToolRef.current === "audio" && tool !== "audio" && recorderRef.current) {
      stopRecording(true); // switched tools mid-recording - discard rather than silently keep recording in the background
    }
    prevToolRef.current = tool;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  const shouldPanWithDrag = (e) => spaceHeld || e.evt.button === 1;

  const handleResizeHandleDown = (shape) => (e) => {
    e.cancelBubble = true; // stop this from also reaching the Stage's onMouseDown, which would select/drag the shape instead
    const screenPos = e.target.getStage().getPointerPosition();
    const world = screenToWorld(screenPos);
    resizingRef.current = { id: shape.id, startBounds: getShapeBounds(shape), startWorld: world };
  };

  const newShapeId = () => `${username}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const startRecording = async (world) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      const chunks = [];
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      mediaRecorder.start();
      recorderRef.current = { mediaRecorder, chunks, stream, x: world.x, y: world.y, startedAt: Date.now() };
      setRecordingElapsedMs(0);
      setRecording({ x: world.x, y: world.y });
    } catch (err) {
      // Most commonly: mic permission denied, or no mic available at
      // all (e.g. desktop without one, or a browser blocking it on a
      // non-HTTPS origin). Either way, surface it through the same
      // error pill Room.jsx already shows for failed image uploads,
      // rather than failing silently.
      onUploadError?.("Couldn't access the microphone - check permissions.");
    }
  };

  const stopRecording = async (cancel = false) => {
    const rec = recorderRef.current;
    if (!rec) {
      setRecording(null);
      return;
    }

    await new Promise((resolve) => {
      if (rec.mediaRecorder.state === "inactive") {
        resolve();
        return;
      }
      rec.mediaRecorder.onstop = resolve;
      rec.mediaRecorder.stop();
    });
    rec.stream.getTracks().forEach((track) => track.stop());
    recorderRef.current = null;
    setRecording(null);

    if (cancel) return;

    const durationMs = Date.now() - rec.startedAt;
    if (durationMs < 300) return; // too short to be a real clip - most likely an accidental click-and-release

    try {
      const blob = new Blob(rec.chunks, { type: rec.mediaRecorder.mimeType || "audio/webm" });
      const upload = await uploadAudio(roomId, blob);
      addShape({
        id: newShapeId(),
        type: "audio",
        x: rec.x - AUDIO_CHIP_SIZE / 2,
        y: rec.y - AUDIO_CHIP_SIZE / 2,
        width: AUDIO_CHIP_SIZE,
        height: AUDIO_CHIP_SIZE,
        url: upload.url,
        durationMs,
        author: username,
      });
    } catch (err) {
      onUploadError?.(err.message || "Audio upload failed");
    }
  };

  const togglePlayback = (shape) => {
    if (playingId === shape.id) {
      audioElementsRef.current[shape.id]?.pause();
      setPlayingId(null);
      return;
    }
    // Only one clip plays at a time - two recordings overlapping would
    // just be noise, not a useful feature.
    if (playingId && audioElementsRef.current[playingId]) {
      audioElementsRef.current[playingId].pause();
      audioElementsRef.current[playingId].currentTime = 0;
    }
    let audio = audioElementsRef.current[shape.id];
    if (!audio) {
      audio = new Audio(shape.url);
      audio.addEventListener("ended", () => setPlayingId((id) => (id === shape.id ? null : id)));
      audioElementsRef.current[shape.id] = audio;
    }
    audio.currentTime = 0;
    audio.play();
    setPlayingId(shape.id);
  };

  const openTextEditorForNew = (world, kind = "text") => {
    if (kind === "sticky") {
      setEditingText({
        id: null,
        kind: "sticky",
        x: world.x,
        y: world.y,
        value: "",
        fontSize: STICKY_FONT_SIZE,
        width: STICKY_SIZE,
        height: STICKY_SIZE,
        bgColor: STICKY_COLOR,
      });
      return;
    }
    setEditingText({ id: null, kind: "text", x: world.x, y: world.y, value: "", fontSize: 20 });
  };

  const openTextEditorForExisting = (shape) => {
    const kind = shape.type === "sticky" ? "sticky" : "text";
    setEditingText({
      id: shape.id,
      kind,
      x: shape.x,
      y: shape.y,
      value: shape.text,
      fontSize: shape.fontSize,
      width: shape.width,
      height: shape.height,
      bgColor: shape.color,
    });
  };

  const commitTextEdit = () => {
    setEditingText((current) => {
      if (!current) return null;
      const value = current.value.trim();
      if (current.id) {
        // Editing an existing shape only ever changes its text - size
        // and color were set at creation and aren't editable here.
        if (value) updateShape(current.id, { text: value });
        else deleteShape(current.id);
      } else if (value) {
        if (current.kind === "sticky") {
          addShape({
            id: newShapeId(),
            type: "sticky",
            x: current.x,
            y: current.y,
            width: current.width,
            height: current.height,
            text: value,
            fontSize: current.fontSize,
            color: current.bgColor,
            author: username,
          });
        } else {
          addShape({
            id: newShapeId(),
            type: "text",
            x: current.x,
            y: current.y,
            text: value,
            fontSize: current.fontSize,
            color: DEFAULT_COLOR,
            author: username,
          });
        }
      }
      return null;
    });
  };

  const cancelTextEdit = () => setEditingText(null);

  const setStickyColor = (color) => {
    setEditingText((current) => {
      if (!current || current.kind !== "sticky") return current;
      // Existing note: color is a real, persisted property, so it
      // updates live for everyone right away, not just on commit -
      // same as dragging it around already does.
      if (current.id) updateShape(current.id, { color });
      return { ...current, bgColor: color };
    });
  };

  const handleTextareaKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      cancelTextEdit();
    }
    // Enter is intentionally left to the textarea's own default
    // behavior (insert a newline) rather than committing - otherwise
    // typing a bulleted or numbered list is impossible, since every
    // Enter would end the note instead of starting the next line.
    // Clicking elsewhere (blur) is the "I'm done" gesture instead.
  };

  // { distance, scale, midpointWorld } while a two-finger pinch is in
  // progress - the only way to zoom on a touchscreen, since there's
  // no wheel event to hook into there. Kept as a ref (not state)
  // since it's read/written every touchmove tick, same reasoning as
  // every other drag-lifecycle ref in this file.
  const pinchRef = useRef(null);

  const getTouchDistance = (touches) => {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  };

  // Native TouchEvent coordinates are relative to the whole browser
  // viewport, not the canvas - screenToWorld (and everything else
  // here) expects coordinates relative to the Stage's own container,
  // so every touch point needs the container's own on-screen offset
  // subtracted first.
  const getTouchMidpointInContainer = (touches) => {
    const rect = stageRef.current.container().getBoundingClientRect();
    return {
      x: (touches[0].clientX + touches[1].clientX) / 2 - rect.left,
      y: (touches[0].clientY + touches[1].clientY) / 2 - rect.top,
    };
  };

  const handlePointerDown = (e) => {
    // Two fingers down means "start a pinch-zoom," full stop - cancel
    // anything a first finger might have already started (drawing,
    // dragging a shape, panning) rather than let both gestures run at
    // once.
    if (e.evt.touches && e.evt.touches.length === 2) {
      isDrawing.current = false;
      isPanning.current = false;
      draggingRef.current = null;
      resizingRef.current = null;
      setDraftShape(null);
      const midpoint = getTouchMidpointInContainer(e.evt.touches);
      pinchRef.current = {
        distance: getTouchDistance(e.evt.touches),
        scale: stageScale,
        midpointWorld: screenToWorld(midpoint),
      };
      return;
    }

    const screenPos = e.target.getStage().getPointerPosition();

    if (shouldPanWithDrag(e)) {
      isPanning.current = true;
      lastPointerScreen.current = screenPos;
      return;
    }

    const world = screenToWorld(screenPos);

    // Audio tool is modal: every click toggles recording on/off,
    // regardless of what's underneath the cursor - it doesn't select
    // or drag existing shapes while active. To move or play back an
    // existing recording, switch to Select first.
    if (tool === "audio") {
      if (recorderRef.current) stopRecording(false);
      else startRecording(world);
      return;
    }

    const hit = hitTest(shapes, world);

    // Shift+click an image to mark it for bulk download, instead of
    // the normal select-and-drag. Checked before the generic hit-test
    // block below so it takes priority - holding Shift is an explicit
    // signal the person wants to pick it, not move it.
    if (e.evt.shiftKey && hit && hit.type === "image") {
      e.evt.preventDefault();
      setPickedForDownload((prev) => {
        const next = new Set(prev);
        if (next.has(hit.id)) next.delete(hit.id);
        else next.add(hit.id);
        return next;
      });
      return;
    }

    // Selection is implicit: clicking directly on any existing shape
    // grabs it for dragging, no matter which tool is active. Only a
    // click on empty canvas falls through to that tool's "create a
    // new thing" behavior below. The one trade-off is you can't start
    // a pen stroke exactly on top of an existing shape - it grabs that
    // shape instead - which is an acceptable cost for not needing a
    // separate Select mode.
    if (hit) {
      setSelectedId(hit.id);
      stopPhysics(hit.id); // hand control back from physics if this shape was mid-flight
      draggingRef.current = { id: hit.id, startShape: hit, startWorld: world };
      dragVelocitySamplesRef.current = [{ x: world.x, y: world.y, t: performance.now() }];
      return;
    }
    setSelectedId(null);

    // Select tool has nothing more to do on an empty-canvas click -
    // it already deselected above. Without this, it would fall
    // through to the pen-drawing default at the bottom of this
    // function and start an unwanted stroke.
    if (tool === "select") return;

    if (tool === "text" || tool === "sticky") {
      dragStartWorld.current = world;
      return;
    }

    if (tool === "rect" || tool === "ellipse" || tool === "triangle" || tool === "star" || tool === "arrow") {
      isDrawing.current = true;
      dragStartWorld.current = world;
      setDraftShape({ type: tool, x: world.x, y: world.y, width: 0, height: 0 });
      return;
    }

    isDrawing.current = true;
    setCurrentPoints([world.x, world.y]);
  };

  const handlePointerMove = (e) => {
    if (e.evt.touches && e.evt.touches.length === 2 && pinchRef.current) {
      e.evt.preventDefault();
      const { distance: startDistance, scale: startScale, midpointWorld } = pinchRef.current;
      const distance = getTouchDistance(e.evt.touches);
      const midpoint = getTouchMidpointInContainer(e.evt.touches);
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, startScale * (distance / startDistance)));
      setStageScale(newScale);
      setStagePos({
        x: midpoint.x - midpointWorld.x * newScale,
        y: midpoint.y - midpointWorld.y * newScale,
      });
      return;
    }

    const screenPos = e.target.getStage().getPointerPosition();
    if (!screenPos) return;

    if (isPanning.current) {
      const dx = screenPos.x - lastPointerScreen.current.x;
      const dy = screenPos.y - lastPointerScreen.current.y;
      setStagePos((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
      lastPointerScreen.current = screenPos;
      return;
    }

    if (resizingRef.current) {
      const world = screenToWorld(screenPos);
      const { id, startBounds, startWorld } = resizingRef.current;
      const delta = { x: world.x - startWorld.x, y: world.y - startWorld.y };
      const MIN_SIZE = 30;
      updateShape(id, {
        width: Math.max(MIN_SIZE, startBounds.width + delta.x),
        height: Math.max(MIN_SIZE, startBounds.height + delta.y),
      });
      return;
    }

    if (draggingRef.current) {
      const world = screenToWorld(screenPos);
      const { startShape, startWorld } = draggingRef.current;
      const delta = { x: world.x - startWorld.x, y: world.y - startWorld.y };
      // Only flip this once real movement is detected, not on every
      // tick once it's already true - a plain click never reaches
      // this since it never travels far enough to cross the
      // threshold at all.
      if (!isActivelyDragging && Math.hypot(delta.x, delta.y) >= CLICK_VS_DRAG_THRESHOLD) {
        setIsActivelyDragging(true);
      }
      // Computed from the shape's position at drag START plus total
      // delta so far, not "current position + this tick's delta" -
      // that avoids any drift from reading a shapes-array copy that
      // may be a tick stale relative to what's already been synced.
      const type = startShape.type || "stroke";
      if (type === "stroke") {
        const points = startShape.points.map((v, i) =>
          i % 2 === 0 ? v + delta.x : v + delta.y
        );
        updateShape(startShape.id, { points });
      } else {
        updateShape(startShape.id, { x: startShape.x + delta.x, y: startShape.y + delta.y });
      }
      // Keep only the most recent few samples - a release-velocity
      // estimate should reflect how the pointer was moving just
      // before letting go, not an average over the whole drag (which
      // would blunt an intentional flick after a slow initial approach).
      dragVelocitySamplesRef.current.push({ x: world.x, y: world.y, t: performance.now() });
      if (dragVelocitySamplesRef.current.length > THROW_VELOCITY_SAMPLES) {
        dragVelocitySamplesRef.current.shift();
      }
      return;
    }

    if (!isDrawing.current) return;
    const world = screenToWorld(screenPos);

    if (tool === "rect" || tool === "ellipse" || tool === "triangle" || tool === "star") {
      const start = dragStartWorld.current;
      setDraftShape({
        type: tool,
        x: Math.min(start.x, world.x),
        y: Math.min(start.y, world.y),
        width: Math.abs(world.x - start.x),
        height: Math.abs(world.y - start.y),
      });
      return;
    }

    if (tool === "arrow") {
      // Deliberately NOT normalized to a positive top-left box like
      // the shapes above - an arrow needs to remember which corner
      // was the drag start and which was the release, so it can point
      // the direction it was actually drawn instead of always
      // pointing the same diagonal way.
      const start = dragStartWorld.current;
      setDraftShape({ type: "arrow", x: start.x, y: start.y, width: world.x - start.x, height: world.y - start.y });
      return;
    }

    setCurrentPoints((prev) => (prev ? [...prev, world.x, world.y] : [world.x, world.y]));
  };

  const handlePointerUp = (e) => {
    if (pinchRef.current) {
      // Fewer than 2 touches left (one finger lifted, or both) -
      // pinch is over either way. Nothing here was ever a
      // single-touch draw/drag/click, so there's nothing to "finish"
      // below - just clear the pinch and stop.
      if (!e.evt.touches || e.evt.touches.length < 2) {
        pinchRef.current = null;
      }
      return;
    }

    if (isPanning.current) {
      isPanning.current = false;
      return;
    }

    if (resizingRef.current) {
      resizingRef.current = null;
      return;
    }

    if (draggingRef.current) {
      const { startShape, startWorld } = draggingRef.current;
      if ((startShape.type || "stroke") === "audio") {
        const screenPos = e?.target?.getStage()?.getPointerPosition();
        const endWorld = screenPos ? screenToWorld(screenPos) : startWorld;
        const dist = Math.hypot(endWorld.x - startWorld.x, endWorld.y - startWorld.y);
        // Only treat it as "just a click" (toggle play/pause) if the
        // pointer barely moved - otherwise this was a genuine drag,
        // and the shape's position has already been updated live by
        // handlePointerMove, so there's nothing left to do here.
        if (dist < CLICK_VS_DRAG_THRESHOLD) togglePlayback(startShape);
      }

      // Was this release fast enough to count as a throw, rather
      // than a slow, deliberate placement? Estimated from the oldest
      // vs newest sample still in the buffer (see
      // dragVelocitySamplesRef's comment above) - using two samples
      // that span a little time, rather than just the last two ticks,
      // smooths out a bit of pointer-event jitter.
      const samples = dragVelocitySamplesRef.current;
      if (samples.length >= 2) {
        const first = samples[0];
        const last = samples[samples.length - 1];
        const dtSeconds = (last.t - first.t) / 1000;
        if (dtSeconds > 0) {
          const vx = (last.x - first.x) / dtSeconds;
          const vy = (last.y - first.y) / dtSeconds;
          const speed = Math.hypot(vx, vy);
          if (speed >= THROW_MIN_SPEED) {
            // Look up the CURRENT shape (handlePointerMove already
            // committed the dragged-to position) rather than
            // startShape, which still has the pre-drag position.
            const currentShape = shapes.find((s) => s.id === startShape.id);
            if (currentShape) registerThrow(currentShape, vx, vy);
          }
        }
      }
      dragVelocitySamplesRef.current = [];

      setIsActivelyDragging(false);
      draggingRef.current = null;
      return;
    }

    if (tool === "text") {
      openTextEditorForNew(dragStartWorld.current, "text");
      return;
    }

    if (tool === "sticky") {
      openTextEditorForNew(dragStartWorld.current, "sticky");
      return;
    }

    if (tool === "rect" || tool === "ellipse" || tool === "triangle" || tool === "star" || tool === "arrow") {
      if (isDrawing.current && draftShape && Math.abs(draftShape.width) > 3 && Math.abs(draftShape.height) > 3) {
        addShape({ id: newShapeId(), color: DEFAULT_COLOR, strokeWidth: 2, author: username, ...draftShape });
      }
      isDrawing.current = false;
      setDraftShape(null);
      return;
    }

    if (isDrawing.current && currentPoints && currentPoints.length >= 4) {
      addShape({
        id: newShapeId(),
        type: "stroke",
        points: currentPoints,
        color: DEFAULT_COLOR,
        strokeWidth: 3,
        author: username,
      });
    }
    isDrawing.current = false;
    setCurrentPoints(null);
  };

  // Double-clicking an existing text or sticky note opens it for
  // editing in place - the single-click case above now selects/drags
  // it instead, matching the standard convention (click moves,
  // double-click edits) so dragging doesn't fight with editing.
  const handleDoubleClick = (e) => {
    const screenPos = e.target.getStage().getPointerPosition();
    if (!screenPos) return;
    const world = screenToWorld(screenPos);
    const hit = hitTest(shapes, world, { predicate: (s) => (s.type || "stroke") === "text" || s.type === "sticky" });
    if (hit) openTextEditorForExisting(hit);
  };

  const handleWheel = (e) => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;

    const isZoomGesture = e.evt.ctrlKey || e.evt.metaKey;

    if (isZoomGesture) {
      const worldBeforeZoom = screenToWorld(pointer);
      const zoomFactor = 1.03;
      const direction = e.evt.deltaY > 0 ? -1 : 1;
      const newScale = direction > 0
        ? Math.min(MAX_SCALE, stageScale * zoomFactor)
        : Math.max(MIN_SCALE, stageScale / zoomFactor);

      setStageScale(newScale);
      setStagePos({
        x: pointer.x - worldBeforeZoom.x * newScale,
        y: pointer.y - worldBeforeZoom.y * newScale,
      });
      return;
    }

    setStagePos((prev) => ({
      x: prev.x - e.evt.deltaX,
      y: prev.y - e.evt.deltaY,
    }));
  };

  const cursorFor = () => {
    if (spaceHeld) return "grab";
    if (tool === "text" || tool === "sticky") return "text";
    if (tool === "select") return "default";
    if (tool === "audio") return "pointer";
    return "crosshair";
  };

  const selectedShape = selectedId ? shapes.find((s) => s.id === selectedId) : null;
  const selectionBounds = selectedShape ? getShapeBounds(selectedShape) : null;
  const selectionPadding = 6 / stageScale;

  // The style panel is a fixed 240px-wide strip along the left edge -
  // if the selected shape's own left edge, in current ON-SCREEN
  // pixels (not world coordinates - this has to account for whatever
  // the current pan/zoom is), falls within that strip, the panel
  // would sit right on top of it. Flipping it to the right edge
  // instead keeps it out of the way, and recomputes live as the shape
  // (or the camera) moves, since this is just a plain render-time
  // calculation, not something set once at selection time.
  const STYLE_PANEL_WIDTH = 240;
  const panelAnchorsRight =
    selectionBounds !== null && selectionBounds.x * stageScale + stagePos.x < STYLE_PANEL_WIDTH;

  // Render order, respecting explicit Bring to Front / Send to Back
  // moves (see the style panel) - shapes without a zIndex default to
  // 0 and simply keep their natural creation-order position relative
  // to each other, since Array.prototype.sort is a stable sort (their
  // relative order going in is preserved when their keys are equal).
  const orderedShapes = [...shapes].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));

  const editorScreen = editingText
    ? {
        left: editingText.x * stageScale + stagePos.x,
        top: HEADER_HEIGHT + editingText.y * stageScale + stagePos.y,
        fontSize: editingText.fontSize * stageScale,
        width: editingText.kind === "sticky" ? editingText.width * stageScale : undefined,
        height: editingText.kind === "sticky" ? editingText.height * stageScale : undefined,
        background: editingText.kind === "sticky" ? editingText.bgColor : undefined,
      }
    : null;

  const recordingScreen = recording
    ? {
        left: recording.x * stageScale + stagePos.x,
        top: HEADER_HEIGHT + recording.y * stageScale + stagePos.y,
      }
    : null;

  return (
    <>
      <StylePanel
        shape={isActivelyDragging ? null : selectedShape}
        anchorRight={panelAnchorsRight}
        onUpdate={(patch) => selectedShape && updateShape(selectedShape.id, patch)}
        onDelete={deleteSelected}
        onBringToFront={bringSelectedToFront}
        onSendToBack={sendSelectedToBack}
        onDuplicate={duplicateSelected}
        onExportPNG={exportSelectedPNG}
        onExportSVG={exportSelectedSVG}
        onExportJSON={exportSelectedJSON}
      />
      <Stage
        ref={stageRef}
        width={viewportSize.width}
        height={viewportSize.height}
        x={stagePos.x}
        y={stagePos.y}
        scaleX={stageScale}
        scaleY={stageScale}
        onMouseDown={handlePointerDown}
        onMouseMove={handlePointerMove}
        onMouseUp={handlePointerUp}
        onDblClick={handleDoubleClick}
        onTouchStart={handlePointerDown}
        onTouchMove={handlePointerMove}
        onTouchEnd={handlePointerUp}
        onDblTap={handleDoubleClick}
        onWheel={handleWheel}
        style={{ background: "#FAFAF8", touchAction: "none", cursor: cursorFor() }}
      >
        <Layer>
          {orderedShapes.map((shape) => {
            const type = shape.type || "stroke";

            if (type === "stroke") {
              return (
                <Line
                  key={shape.id} id={shape.id} name="shape-node"
                  points={shape.points}
                  stroke={shape.color}
                  strokeWidth={shape.strokeWidth}
                  lineCap="round"
                  lineJoin="round"
                  tension={0.4}
                />
              );
            }
            if (type === "rect") {
              return (
                <Group key={shape.id} id={shape.id} name="shape-node" {...rotationGroupProps(shape)}>
                  <Rect
                    x={shape.x}
                    y={shape.y}
                    width={shape.width}
                    height={shape.height}
                    stroke={shape.color}
                    strokeWidth={shape.strokeWidth || 2}
                  />
                </Group>
              );
            }
            if (type === "ellipse") {
              return (
                <Group key={shape.id} id={shape.id} name="shape-node" {...rotationGroupProps(shape)}>
                  <Ellipse
                    x={shape.x + shape.width / 2}
                    y={shape.y + shape.height / 2}
                    radiusX={shape.width / 2}
                    radiusY={shape.height / 2}
                    stroke={shape.color}
                    strokeWidth={shape.strokeWidth || 2}
                  />
                </Group>
              );
            }
            if (type === "triangle") {
              return (
                <Group key={shape.id} id={shape.id} name="shape-node" {...rotationGroupProps(shape)}>
                  <Line
                    points={trianglePoints(shape.x, shape.y, shape.width, shape.height)}
                    closed
                    stroke={shape.color}
                    strokeWidth={shape.strokeWidth || 2}
                  />
                </Group>
              );
            }
            if (type === "star") {
              return (
                <Group key={shape.id} id={shape.id} name="shape-node" {...rotationGroupProps(shape)}>
                  <Line
                    points={starPoints(shape.x, shape.y, shape.width, shape.height)}
                    closed
                    stroke={shape.color}
                    strokeWidth={shape.strokeWidth || 2}
                  />
                </Group>
              );
            }
            if (type === "arrow") {
              return (
                <Group key={shape.id} id={shape.id} name="shape-node" {...rotationGroupProps(shape)}>
                  <Arrow
                    points={[shape.x, shape.y, shape.x + shape.width, shape.y + shape.height]}
                    stroke={shape.color}
                    fill={shape.color}
                    strokeWidth={shape.strokeWidth || 2}
                    pointerLength={14}
                    pointerWidth={12}
                  />
                </Group>
              );
            }
            if (type === "text") {
              if (editingText && editingText.id === shape.id) return null;
              return (
                <Text
                  key={shape.id} id={shape.id} name="shape-node"
                  x={shape.x}
                  y={shape.y}
                  text={shape.text}
                  fontSize={shape.fontSize}
                  fontFamily={shape.fontFamily || "Inter, system-ui, sans-serif"}
                  fontStyle={konvaFontStyle(shape)}
                  fill={shape.color}
                />
              );
            }
            if (type === "sticky") {
              if (editingText && editingText.id === shape.id) return null;
              // A sticky note can "take" a shape's outline via physics
              // collision (see usePhysics.js) - shapeKind is undefined
              // for every sticky created normally, which keeps the
              // usual rounded-rect look.
              const stickyKind = shape.shapeKind || "rect";
              const shadowProps = {
                shadowColor: "#000",
                shadowOpacity: 0.15,
                shadowBlur: 6,
                shadowOffsetY: 2,
              };
              const textBox = stickyTextBox(shape);
              return (
                <Group key={shape.id} id={shape.id} name="shape-node" {...rotationGroupProps(shape)}>
                  {stickyKind === "ellipse" ? (
                    <Ellipse
                      x={shape.x + shape.width / 2}
                      y={shape.y + shape.height / 2}
                      radiusX={shape.width / 2}
                      radiusY={shape.height / 2}
                      fill={shape.color}
                      {...shadowProps}
                    />
                  ) : stickyKind === "triangle" ? (
                    <Line
                      points={trianglePoints(shape.x, shape.y, shape.width, shape.height)}
                      closed
                      fill={shape.color}
                      {...shadowProps}
                    />
                  ) : stickyKind === "star" ? (
                    <Line
                      points={starPoints(shape.x, shape.y, shape.width, shape.height)}
                      closed
                      fill={shape.color}
                      {...shadowProps}
                    />
                  ) : (
                    <Rect
                      x={shape.x}
                      y={shape.y}
                      width={shape.width}
                      height={shape.height}
                      fill={shape.color}
                      cornerRadius={4}
                      {...shadowProps}
                    />
                  )}
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
                </Group>
              );
            }
            if (type === "audio") {
              const isPlaying = playingId === shape.id;
              const cx = shape.x + shape.width / 2;
              const cy = shape.y + shape.height / 2;
              return (
                <Group key={shape.id} id={shape.id} name="shape-node" {...rotationGroupProps(shape)}>
                  <Rect
                    x={shape.x}
                    y={shape.y}
                    width={shape.width}
                    height={shape.height}
                    fill="#fff"
                    stroke={isPlaying ? "#2F6F6B" : DEFAULT_COLOR}
                    strokeWidth={1.5}
                    cornerRadius={shape.height / 2}
                    shadowColor="#000"
                    shadowOpacity={0.12}
                    shadowBlur={5}
                    shadowOffsetY={1}
                  />
                  {isPlaying ? (
                    <Group>
                      <Rect x={cx - 7} y={cy - 8} width={4} height={16} fill="#2F6F6B" cornerRadius={1} />
                      <Rect x={cx + 3} y={cy - 8} width={4} height={16} fill="#2F6F6B" cornerRadius={1} />
                    </Group>
                  ) : (
                    <Line
                      points={[cx - 6, cy - 8, cx - 6, cy + 8, cx + 9, cy]}
                      closed
                      fill={DEFAULT_COLOR}
                    />
                  )}
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
              const isPicked = pickedForDownload.has(shape.id);
              return (
                <Group key={shape.id} id={shape.id} name="shape-node" {...rotationGroupProps(shape)}>
                  <CanvasImage shape={shape} />
                  {isPicked && (
                    <Rect
                      x={shape.x - 3}
                      y={shape.y - 3}
                      width={shape.width + 6}
                      height={shape.height + 6}
                      stroke="#2F6F6B"
                      strokeWidth={3}
                      listening={false}
                    />
                  )}
                </Group>
              );
            }
            return null;
          })}

          {currentPoints && (
            <Line
              points={currentPoints}
              stroke={DEFAULT_COLOR}
              strokeWidth={3}
              lineCap="round"
              lineJoin="round"
              tension={0.4}
            />
          )}
          {draftShape && draftShape.type === "rect" && (
            <Rect
              x={draftShape.x}
              y={draftShape.y}
              width={draftShape.width}
              height={draftShape.height}
              stroke={DEFAULT_COLOR}
              strokeWidth={2}
              dash={[6, 4]}
            />
          )}
          {draftShape && draftShape.type === "ellipse" && (
            <Ellipse
              x={draftShape.x + draftShape.width / 2}
              y={draftShape.y + draftShape.height / 2}
              radiusX={draftShape.width / 2}
              radiusY={draftShape.height / 2}
              stroke={DEFAULT_COLOR}
              strokeWidth={2}
              dash={[6, 4]}
            />
          )}
          {draftShape && draftShape.type === "triangle" && (
            <Line
              points={trianglePoints(draftShape.x, draftShape.y, draftShape.width, draftShape.height)}
              closed
              stroke={DEFAULT_COLOR}
              strokeWidth={2}
              dash={[6, 4]}
            />
          )}
          {draftShape && draftShape.type === "star" && (
            <Line
              points={starPoints(draftShape.x, draftShape.y, draftShape.width, draftShape.height)}
              closed
              stroke={DEFAULT_COLOR}
              strokeWidth={2}
              dash={[6, 4]}
            />
          )}
          {draftShape && draftShape.type === "arrow" && (
            <Arrow
              points={[draftShape.x, draftShape.y, draftShape.x + draftShape.width, draftShape.y + draftShape.height]}
              stroke={DEFAULT_COLOR}
              fill={DEFAULT_COLOR}
              strokeWidth={2}
              dash={[6, 4]}
              pointerLength={14}
              pointerWidth={12}
            />
          )}
          {selectionBounds && (
            <Rect
              name="export-hide"
              x={selectionBounds.x - selectionPadding}
              y={selectionBounds.y - selectionPadding}
              width={selectionBounds.width + selectionPadding * 2}
              height={selectionBounds.height + selectionPadding * 2}
              stroke="#2F6F6B"
              strokeWidth={1.5 / stageScale}
              dash={[5 / stageScale, 4 / stageScale]}
              listening={false}
            />
          )}
          {selectedShape && RESIZABLE_TYPES.includes(selectedShape.type) && selectionBounds && (
            <Rect
              name="export-hide"
              x={selectionBounds.x + selectionBounds.width + selectionPadding - 6 / stageScale}
              y={selectionBounds.y + selectionBounds.height + selectionPadding - 6 / stageScale}
              width={12 / stageScale}
              height={12 / stageScale}
              fill="#2F6F6B"
              stroke="#fff"
              strokeWidth={1.5 / stageScale}
              cornerRadius={2 / stageScale}
              onMouseDown={handleResizeHandleDown(selectedShape)}
              onTouchStart={handleResizeHandleDown(selectedShape)}
            />
          )}
        </Layer>
      </Stage>

      {editorScreen && editingText.kind === "sticky" && (
        <div
          className="sticky-swatches"
          style={{ left: editorScreen.left, top: editorScreen.top - 34 }}
        >
          {STICKY_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={`sticky-swatch ${editingText.bgColor === color ? "selected" : ""}`}
              style={{ background: color }}
              // mousedown (not click) + preventDefault, so clicking a
              // swatch never steals focus from the textarea - if it
              // did, the textarea's onBlur would fire first and
              // commit/close the editor before the color change had
              // any note left to apply to.
              onMouseDown={(e) => {
                e.preventDefault();
                setStickyColor(color);
              }}
              aria-label={`Set sticky note color to ${color}`}
            />
          ))}
        </div>
      )}
      {editorScreen && (
        <textarea
          ref={textareaRef}
          className={`inline-text-editor ${editingText.kind === "sticky" ? "sticky" : ""}`}
          value={editingText.value}
          onChange={(e) => setEditingText((cur) => ({ ...cur, value: e.target.value }))}
          onBlur={commitTextEdit}
          onKeyDown={handleTextareaKeyDown}
          style={{
            left: editorScreen.left,
            top: editorScreen.top,
            fontSize: editorScreen.fontSize,
            width: editorScreen.width,
            height: editorScreen.height,
            background: editorScreen.background,
          }}
        />
      )}
      {recordingScreen && (
        <div className="audio-recording-pill" style={{ left: recordingScreen.left, top: recordingScreen.top }}>
          <span className="rec-dot" />
          {formatDuration(recordingElapsedMs)} · click to stop
        </div>
      )}
      {pickedForDownload.size > 0 && (
        <div className="download-picker-bar">
          <span>
            {pickedForDownload.size} image{pickedForDownload.size === 1 ? "" : "s"} selected
          </span>
          <button
            className="download-picker-clear"
            onClick={() => setPickedForDownload(new Set())}
            title="Clear selection"
          >
            Clear
          </button>
          <button
            className="download-picker-download"
            onClick={() => {
              const picked = shapes.filter((s) => pickedForDownload.has(s.id));
              onDownloadImages?.(picked);
              setPickedForDownload(new Set());
            }}
          >
            Download
          </button>
        </div>
      )}
    </>
  );
});

function CanvasImage({ shape }) {
  const image = useHtmlImage(shape.url);
  if (!image) return null;
  return <KonvaImage image={image} x={shape.x} y={shape.y} width={shape.width} height={shape.height} />;
}

export default Canvas;
