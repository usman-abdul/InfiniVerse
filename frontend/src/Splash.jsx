import { useEffect, useRef, useState } from "react";

const DISPLAY_MS = 5000;
const FADE_MS = 500;

const STAR_COLS = 14;
const STAR_ROWS = 9;

/**
 * Builds an evenly-spaced grid of star positions (so it still reads as
 * "canvas / graph paper" - the same functional pattern most drawing
 * tools use for their background) but gives each dot randomized size,
 * opacity, and twinkle timing (so it also reads as a starfield). Grid
 * spacing keeps the "canvas" meaning; the per-dot jitter is what tips
 * it toward "universe" without losing that.
 */
function generateStars() {
  const stars = [];
  for (let row = 0; row < STAR_ROWS; row++) {
    for (let col = 0; col < STAR_COLS; col++) {
      // Small random offset off the grid point so it doesn't look
      // mechanically plotted.
      const jitterX = (Math.random() - 0.5) * 5;
      const jitterY = (Math.random() - 0.5) * 5;
      const left = ((col + 0.5) / STAR_COLS) * 100 + jitterX;
      const top = ((row + 0.5) / STAR_ROWS) * 100 + jitterY;

      // Most dots stay small and faint; a minority run bigger/brighter,
      // which is the actual thing that sells "stars" over "grid".
      const isBright = Math.random() < 0.25;
      const size = isBright ? 3.5 + Math.random() * 2 : 2 + Math.random() * 1.5;
      const baseOpacity = isBright ? 0.65 + Math.random() * 0.3 : 0.3 + Math.random() * 0.25;

      stars.push({
        id: `${row}-${col}`,
        left,
        top,
        size,
        baseOpacity,
        duration: 2.4 + Math.random() * 2.6,
        delay: Math.random() * 4,
      });
    }
  }
  return stars;
}

/**
 * One-time startup splash. Shows the InfiniVerse wordmark with a
 * small shape-drawing animation - a circle, square, and freehand
 * squiggle each tracing their own outline in sequence, echoing the
 * app's own pen/rectangle/ellipse tools rather than a generic spinner
 * - over a faint, slowly-twinkling star grid, then fades into the
 * guest login screen.
 *
 * Shown once per page load only (App.jsx's showSplash state never
 * resets back to true), not every time the user returns to the entry
 * screen after leaving a room.
 */
export default function Splash({ onFinish }) {
  const [fading, setFading] = useState(false);
  const [stars] = useState(generateStars);
  const fadeTimerRef = useRef(null);
  const doneTimerRef = useRef(null);

  useEffect(() => {
    fadeTimerRef.current = setTimeout(() => setFading(true), DISPLAY_MS);
    doneTimerRef.current = setTimeout(() => onFinish(), DISPLAY_MS + FADE_MS);
    return () => {
      clearTimeout(fadeTimerRef.current);
      clearTimeout(doneTimerRef.current);
    };
  }, [onFinish]);

  const handleSkip = () => {
    // Already fading (either from the timer or a previous click) -
    // ignore, the scheduled onFinish will fire on its own.
    if (fading) return;
    clearTimeout(fadeTimerRef.current);
    clearTimeout(doneTimerRef.current);
    setFading(true);
    setTimeout(() => onFinish(), FADE_MS);
  };

  return (
    <div className={`splash ${fading ? "fading" : ""}`} onClick={handleSkip}>
      <div className="splash-stars" aria-hidden="true">
        {stars.map((star) => (
          <span
            key={star.id}
            className="splash-star"
            style={{
              left: `${star.left}%`,
              top: `${star.top}%`,
              width: `${star.size}px`,
              height: `${star.size}px`,
              "--star-opacity": star.baseOpacity,
              animationDuration: `${star.duration}s`,
              animationDelay: `${star.delay}s`,
            }}
          />
        ))}
      </div>
      <div className="splash-content">
        <svg className="splash-shapes" width="190" height="76" viewBox="0 0 140 56" fill="none" aria-hidden="true">
          <circle cx="20" cy="28" r="16" stroke="#2F6F6B" strokeWidth="2.5" className="splash-shape splash-shape-1" />
          <rect
            x="54"
            y="12"
            width="32"
            height="32"
            rx="4"
            stroke="#2F6F6B"
            strokeWidth="2.5"
            className="splash-shape splash-shape-2"
          />
          <path
            d="M104 38c4-16 10-24 16-24s6 20 12 20 4-10 8-10"
            stroke="#2F6F6B"
            strokeWidth="2.5"
            strokeLinecap="round"
            className="splash-shape splash-shape-3"
          />
        </svg>
        <h1 className="splash-title">InfiniVerse</h1>
        <p className="splash-tagline">An endless canvas for ideas, together</p>
        <div className="splash-loading-dots">
          <span />
          <span />
          <span />
        </div>
        <p className="splash-skip-hint">Tap to skip</p>
      </div>
    </div>
  );
}
