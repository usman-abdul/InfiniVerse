import { useEffect, useState } from "react";

/**
 * Figma-style properties panel: appears automatically whenever a
 * shape is selected (no button to find - see Canvas.jsx, which
 * renders this as a permanent sibling of the canvas and just toggles
 * its "open" class based on selectedId), and disappears the moment
 * nothing is selected.
 *
 * Kept permanently mounted rather than conditionally rendered
 * ({selectedId && <StylePanel/>}) specifically so it can animate its
 * own disappearance - React would otherwise unmount it instantly on
 * deselect, giving a CSS transition zero time to play. Fully hidden
 * (translated off-screen, non-interactive) when nothing's selected,
 * so it never "sticks out" beforehand.
 */

const COLOR_PALETTE = [
  "#2B2B2E",
  "#C1502E",
  "#E85D04",
  "#2F6F6B",
  "#3B6EA5",
  "#8B5CF6",
  "#FFE9A8",
  "#B8E1FF",
  "#C8F7C5",
  "#FFC9DE",
];

// Only fonts actually loaded by the app (see index.html's Google
// Fonts link) - offering anything else would silently fall back to
// the browser default instead of rendering what's picked.
const FONT_OPTIONS = [
  { value: "Inter, system-ui, sans-serif", label: "Inter" },
  { value: "'Space Grotesk', sans-serif", label: "Space Grotesk" },
  { value: "'JetBrains Mono', monospace", label: "JetBrains Mono" },
];

// Shapes with an outline (stroke) whose width the panel can control -
// pen strokes have their own separate "Pen width" label below since
// "stroke" reads oddly as a type name in the UI.
const OUTLINE_TYPES = ["rect", "ellipse", "triangle", "star", "arrow"];
const FONT_TYPES = ["text", "sticky"];
// Matches exactly what Canvas.jsx wraps in a rotation Group - see
// rotationGroupProps there. Pen strokes and plain text are excluded
// (see that comment for why).
const ROTATABLE_TYPES = ["rect", "ellipse", "triangle", "star", "arrow", "sticky", "image"];
// Alignment only makes sense for sticky notes - "text" shapes have no
// fixed width for text to align within (they just auto-size to their
// content), so an alignment control there would visibly do nothing.
const ALIGNABLE_TYPES = ["sticky"];
// image and audio have no color field at all (a photo's colors are
// its own, and an audio chip is rendered in a fixed neutral style) -
// showing a color swatch grid for either would control nothing.
const NO_COLOR_TYPES = ["image", "audio"];

const TYPE_LABELS = {
  rect: "Rectangle",
  ellipse: "Ellipse",
  triangle: "Triangle",
  star: "Star",
  arrow: "Arrow",
  text: "Text",
  sticky: "Sticky Note",
  image: "Image",
  audio: "Audio",
  stroke: "Pen Stroke",
};

// A range slider paired with a plain number input, both controlling
// the same value - dragging is fast for rough adjustments, but there
// was previously no way to type an exact number (e.g. "rotate exactly
// 90 degrees" meant eyeballing a slider).
//
// The number input tracks its OWN local text while being typed into,
// separate from the clamped `value` prop, and only clamps + commits
// on blur or Enter - not on every keystroke. Clamping live would make
// typing a value impossible whenever an early keystroke lands outside
// the range on its own: e.g. with a minimum of 10, typing "12" digit
// by digit means the field briefly holds just "1" - clamping THAT
// immediately up to 10 before the "2" can be typed would make "12"
// unreachable by typing, even though it's a perfectly valid value.
function SliderWithNumberInput({ min, max, value, onChange }) {
  const [text, setText] = useState(String(value));

  // Keep the displayed text in sync whenever the true value changes
  // from outside this input (the slider, or another peer's edit
  // arriving over Yjs) - `value` only changes here once typing is
  // committed (see commit() below), so this never fights with an
  // in-progress keystroke.
  useEffect(() => {
    setText(String(value));
  }, [value]);

  const commit = () => {
    const num = Number(text);
    if (Number.isNaN(num)) {
      setText(String(value)); // not a number at all - revert rather than commit garbage
      return;
    }
    onChange(Math.max(min, Math.min(max, num)));
  };

  return (
    <div className="style-slider-row">
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <input
        type="number"
        min={min}
        max={max}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            e.target.blur();
          }
        }}
        className="style-number-input"
      />
    </div>
  );
}

// A section label with its unit shown alongside it (e.g. "Rotation
// (°)") - context for what the number in the box actually means,
// rather than a bare unlabeled number.
function LabelWithUnit({ text, unit }) {
  return (
    <div className="style-panel-label">
      {text} <span className="style-panel-unit">({unit})</span>
    </div>
  );
}

export default function StylePanel({
  shape,
  anchorRight,
  onUpdate,
  onDelete,
  onBringToFront,
  onSendToBack,
  onDuplicate,
  onExportPNG,
  onExportSVG,
  onExportJSON,
}) {
  const isOpen = Boolean(shape);

  return (
    <div className={`style-panel ${isOpen ? "open" : ""} ${anchorRight ? "anchor-right" : ""}`}>
      {shape && (
        <StylePanelContent
          shape={shape}
          onUpdate={onUpdate}
          onDelete={onDelete}
          onBringToFront={onBringToFront}
          onSendToBack={onSendToBack}
          onDuplicate={onDuplicate}
          onExportPNG={onExportPNG}
          onExportSVG={onExportSVG}
          onExportJSON={onExportJSON}
        />
      )}
    </div>
  );
}

function StylePanelContent({
  shape,
  onUpdate,
  onDelete,
  onBringToFront,
  onSendToBack,
  onDuplicate,
  onExportPNG,
  onExportSVG,
  onExportJSON,
}) {
  const type = shape.type || "stroke";
  const showColor = !NO_COLOR_TYPES.includes(type);
  const showStrokeWidth = OUTLINE_TYPES.includes(type);
  const showPenWidth = type === "stroke";
  const showFontSize = FONT_TYPES.includes(type);
  const showFontControls = FONT_TYPES.includes(type);
  const showAlign = ALIGNABLE_TYPES.includes(type);
  const showRotation = ROTATABLE_TYPES.includes(type);

  return (
    <>
      <div className="style-panel-header">{TYPE_LABELS[type] || "Shape"}</div>

      {showColor && (
        <div className="style-panel-section">
          <div className="style-panel-label">Color</div>
          <div className="style-panel-swatches">
            {COLOR_PALETTE.map((color) => (
              <button
                key={color}
                className={`style-swatch ${shape.color === color ? "selected" : ""}`}
                style={{ background: color }}
                onClick={() => onUpdate({ color })}
                aria-label={color}
                title={color}
              />
            ))}
            <div className="style-swatch-custom-wrapper" title="Custom color">
              <input
                type="color"
                className="style-swatch-custom"
                value={/^#[0-9a-fA-F]{6}$/.test(shape.color) ? shape.color : "#000000"}
                onChange={(e) => onUpdate({ color: e.target.value })}
                aria-label="Custom color"
              />
              <span className="style-swatch-custom-badge" aria-hidden="true">
                +
              </span>
            </div>
          </div>
        </div>
      )}

      {showStrokeWidth && (
        <div className="style-panel-section">
          <LabelWithUnit text="Stroke width" unit="px" />
          <SliderWithNumberInput
            min={1}
            max={10}
            value={shape.strokeWidth || 2}
            onChange={(v) => onUpdate({ strokeWidth: v })}
          />
        </div>
      )}

      {showPenWidth && (
        <div className="style-panel-section">
          <LabelWithUnit text="Pen width" unit="px" />
          <SliderWithNumberInput
            min={1}
            max={14}
            value={shape.strokeWidth || 3}
            onChange={(v) => onUpdate({ strokeWidth: v })}
          />
        </div>
      )}

      {showRotation && (
        <div className="style-panel-section">
          <LabelWithUnit text="Rotation" unit="°" />
          <SliderWithNumberInput
            min={-180}
            max={180}
            value={shape.rotation || 0}
            onChange={(v) => onUpdate({ rotation: v })}
          />
        </div>
      )}

      {showFontSize && (
        <div className="style-panel-section">
          <LabelWithUnit text="Font size" unit="px" />
          <SliderWithNumberInput
            min={10}
            max={56}
            value={shape.fontSize || 16}
            onChange={(v) => onUpdate({ fontSize: v })}
          />
        </div>
      )}

      {showFontControls && (
        <div className="style-panel-section">
          <div className="style-panel-label">Font</div>
          <select
            className="style-font-select"
            value={shape.fontFamily || FONT_OPTIONS[0].value}
            onChange={(e) => onUpdate({ fontFamily: e.target.value })}
          >
            {FONT_OPTIONS.map((font) => (
              <option key={font.value} value={font.value}>
                {font.label}
              </option>
            ))}
          </select>
          <div className="style-panel-button-row">
            <button
              className={`style-toggle-btn ${shape.bold ? "active" : ""}`}
              onClick={() => onUpdate({ bold: !shape.bold })}
              aria-label="Bold"
              title="Bold"
            >
              <strong>B</strong>
            </button>
            <button
              className={`style-toggle-btn ${shape.italic ? "active" : ""}`}
              onClick={() => onUpdate({ italic: !shape.italic })}
              aria-label="Italic"
              title="Italic"
            >
              <em>I</em>
            </button>
          </div>
        </div>
      )}

      {showAlign && (
        <div className="style-panel-section">
          <div className="style-panel-label">Alignment</div>
          <div className="style-panel-button-row">
            {["left", "center", "right"].map((align) => (
              <button
                key={align}
                className={`style-toggle-btn ${(shape.align || "left") === align ? "active" : ""}`}
                onClick={() => onUpdate({ align })}
                aria-label={`Align ${align}`}
                title={`Align ${align}`}
              >
                {align === "left" ? "⟵" : align === "center" ? "↔" : "⟶"}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="style-panel-section">
        <div className="style-panel-label">Layer</div>
        <div className="style-panel-button-row">
          <button className="style-panel-action" onClick={onBringToFront}>
            Bring to Front
          </button>
          <button className="style-panel-action" onClick={onSendToBack}>
            Send to Back
          </button>
        </div>
      </div>

      <button className="style-panel-action" onClick={onDuplicate} style={{ marginBottom: 10 }}>
        Duplicate
      </button>

      <div className="style-panel-section">
        <div className="style-panel-label">Export this object</div>
        <div className="style-panel-button-row">
          <button className="style-panel-action" onClick={onExportPNG}>
            PNG
          </button>
          <button className="style-panel-action" onClick={onExportSVG}>
            SVG
          </button>
          <button className="style-panel-action" onClick={onExportJSON}>
            JSON
          </button>
        </div>
      </div>

      <button className="style-panel-delete" onClick={onDelete}>
        Delete
      </button>
    </>
  );
}
