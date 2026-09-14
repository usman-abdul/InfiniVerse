import { useEffect, useRef, useState } from "react";

/**
 * Small inline icon set, kept as plain SVG rather than an icon library
 * dependency - one less package to install this close to a deadline,
 * and five icons is little enough that hand-drawing them is cheap.
 * Each is 20x20, stroke-based, uses currentColor so it inherits the
 * button's text color (including the "active" state's white).
 */
const ICONS = {
  select: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <path d="M5 3l10 8-4.2.6L13 16l-2.3 1L8.5 12l-3 2.3V3z" fill="currentColor" />
    </svg>
  ),
  pen: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <path
        d="M13.5 3.5l3 3L6 17H3v-3L13.5 3.5z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  ),
  rect: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <rect x="3.5" y="5" width="13" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  ),
  ellipse: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <ellipse cx="10" cy="10" rx="6.5" ry="5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  ),
  triangle: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <path d="M10 4l6.5 11H3.5L10 4z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  ),
  star: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <path
        d="M10 3l1.8 4.6L16.5 8l-3.7 3.1L14 16l-4-2.6L6 16l1.2-4.9L3.5 8l4.7-.4L10 3z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  ),
  arrow: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <path d="M4.5 15.5L15 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M9.5 5h5.5v5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  shapes: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <rect x="3" y="7.5" width="8.5" height="8.5" rx="1.2" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="14.2" cy="6" r="3.7" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  ),
  text: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <path d="M4 5h12M10 5v10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  sticky: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <path
        d="M4 4h9l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M13 4v3h3" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  ),
  audio: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <rect x="7.5" y="2.5" width="5" height="9" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  image: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <rect x="3" y="4" width="14" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="7.2" cy="8" r="1.2" fill="currentColor" />
      <path d="M4 14l4-4 3 3 3-3.5 4 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  ),
  recenter: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="3" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M10 1.5v3M10 15.5v3M18.5 10h-3M4.5 10h-3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  ),
  attract: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <path d="M4 6l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16 6l-4 4 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  repel: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <path d="M8 6l-4 4 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 6l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  physics: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="2" fill="currentColor" />
      <ellipse cx="10" cy="10" rx="8.5" ry="3.8" stroke="currentColor" strokeWidth="1.5" />
      <ellipse cx="10" cy="10" rx="8.5" ry="3.8" stroke="currentColor" strokeWidth="1.5" transform="rotate(90 10 10)" />
    </svg>
  ),
};

const TOOLS_BEFORE_CENTER = [
  { id: "select", label: "Select" },
  { id: "pen", label: "Pen" },
];

const SHAPE_TOOLS = [
  { id: "rect", label: "Rectangle" },
  { id: "ellipse", label: "Ellipse" },
  { id: "triangle", label: "Triangle" },
  { id: "star", label: "Star" },
  { id: "arrow", label: "Arrow" },
];

const TOOLS_AFTER_CENTER = [
  { id: "text", label: "Text" },
  { id: "sticky", label: "Sticky Note" },
  { id: "audio", label: "Audio" },
];

const PHYSICS_ACTIONS = [
  { id: "attract", label: "Attract" },
  { id: "repel", label: "Repel" },
];

/**
 * Floating tool picker, overlaid on the canvas rather than taking a
 * row of its own - keeps the canvas full-height and matches how
 * infinite-canvas apps (Figma, Miro) typically place tool switching.
 *
 * "Select" is included as an explicit tool for clarity, but note it's
 * not actually load-bearing: clicking any existing shape grabs it for
 * dragging no matter which tool is active (see Canvas.jsx's implicit
 * hit-test-on-click), so Select mostly just gives users a clear,
 * familiar "I'm just clicking around, not drawing" home base.
 *
 * "Image" is deliberately not a persistent tool like the others - it
 * opens a native file picker immediately, uploads, and places the
 * image, without changing whatever tool you were already using (so
 * picking an image while on "pen" doesn't strand you needing to
 * switch back).
 *
 * "Attract" and "Repel" are one-off actions too, same as Recenter -
 * each applies a single physics pulse centered on whatever's
 * currently in view (see usePhysics.js), rather than toggling into a
 * standing "force field" mode. They live behind their own "Physics"
 * flyout for the same reason the shape tools do (see below) - two
 * closely-related one-off actions don't each need a permanent slot.
 *
 * The five shape tools (rectangle/ellipse/triangle/star/arrow) live
 * behind a single "Shapes" flyout button rather than five permanent
 * icons - matching how Figma and similar tools actually do this
 * (one shape tool that opens a small picker), and the more scalable
 * pattern generally: every new shape type used to mean one more
 * permanent toolbar icon, which doesn't hold up. The flyout button
 * shows whichever shape tool is currently active, or a generic
 * shapes glyph when none of the five is selected.
 */
export default function Toolbar({ tool, setTool, onImageSelected, onRecenter, onAttract, onRepel }) {
  const fileInputRef = useRef(null);
  const [shapesMenuOpen, setShapesMenuOpen] = useState(false);
  const shapesMenuRef = useRef(null);
  const [physicsMenuOpen, setPhysicsMenuOpen] = useState(false);
  const physicsMenuRef = useRef(null);

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (file) onImageSelected(file);
    e.target.value = ""; // allow re-selecting the same file later
  };

  // Close the flyout on any click outside it - same pattern as
  // Room.jsx's export menu.
  useEffect(() => {
    if (!shapesMenuOpen) return;
    const onClickOutside = (e) => {
      if (shapesMenuRef.current && !shapesMenuRef.current.contains(e.target)) {
        setShapesMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [shapesMenuOpen]);

  useEffect(() => {
    if (!physicsMenuOpen) return;
    const onClickOutside = (e) => {
      if (physicsMenuRef.current && !physicsMenuRef.current.contains(e.target)) {
        setPhysicsMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [physicsMenuOpen]);

  const activeShapeTool = SHAPE_TOOLS.find((t) => t.id === tool);

  const physicsHandlers = { attract: onAttract, repel: onRepel };

  return (
    <div className="toolbar">
      {TOOLS_BEFORE_CENTER.map((t) => (
        <button
          key={t.id}
          className={`tool-btn ${tool === t.id ? "active" : ""}`}
          onClick={() => setTool(t.id)}
          title={t.label}
          aria-label={t.label}
        >
          {ICONS[t.id]}
        </button>
      ))}

      <div className="flyout-menu" ref={shapesMenuRef}>
        <button
          className={`tool-btn ${activeShapeTool ? "active" : ""}`}
          onClick={() => setShapesMenuOpen((open) => !open)}
          title="Shapes"
          aria-label="Shapes"
        >
          {ICONS[activeShapeTool?.id || "shapes"]}
        </button>
        {shapesMenuOpen && (
          <div className="flyout-dropdown">
            {SHAPE_TOOLS.map((t) => (
              <button
                key={t.id}
                className={`tool-btn ${tool === t.id ? "active" : ""}`}
                onClick={() => {
                  setTool(t.id);
                  setShapesMenuOpen(false);
                }}
                title={t.label}
                aria-label={t.label}
              >
                {ICONS[t.id]}
              </button>
            ))}
          </div>
        )}
      </div>

      <button className="tool-btn" onClick={onRecenter} title="Recenter" aria-label="Recenter">
        {ICONS.recenter}
      </button>

      {TOOLS_AFTER_CENTER.map((t) => (
        <button
          key={t.id}
          className={`tool-btn ${tool === t.id ? "active" : ""}`}
          onClick={() => setTool(t.id)}
          title={t.label}
          aria-label={t.label}
        >
          {ICONS[t.id]}
        </button>
      ))}

      <button className="tool-btn" onClick={() => fileInputRef.current?.click()} title="Image" aria-label="Image">
        {ICONS.image}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        style={{ display: "none" }}
        onChange={handleFileChange}
      />

      <div className="flyout-menu" ref={physicsMenuRef}>
        <button
          className="tool-btn"
          onClick={() => setPhysicsMenuOpen((open) => !open)}
          title="Physics"
          aria-label="Physics"
        >
          {ICONS.physics}
        </button>
        {physicsMenuOpen && (
          <div className="flyout-dropdown">
            {PHYSICS_ACTIONS.map((a) => (
              <button
                key={a.id}
                className="tool-btn"
                onClick={() => {
                  physicsHandlers[a.id]?.();
                  setPhysicsMenuOpen(false);
                }}
                title={a.label}
                aria-label={a.label}
              >
                {ICONS[a.id]}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
