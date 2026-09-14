import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

// Persisted per-browser, not per-room or per-account (there's no real
// auth here - see the README's note on that) - once dismissed, it
// stays dismissed everywhere this browser opens the app again.
const STORAGE_KEY = "infiniverse-onboarding-seen";

// Plain numbered tips rather than custom pictograms for each one -
// deliberately avoiding a repeat of the icon-legibility problems the
// Physics/Attract/Repel icons already went through (a magnet that
// read as headphones, an atom that read as a gear). Five new icons
// designed and shipped without ever being seen in a real browser is
// exactly the kind of risk not worth taking here.
const TIPS = [
  {
    title: "Draw and add shapes",
    body: "Use the pen to sketch freehand, or open the Shapes flyout for rectangles, circles, and more.",
  },
  {
    title: "Throw things around",
    body: "Drag an object and let go with a flick - it flies, bounces, and collides with whatever's in its path.",
  },
  {
    title: "Matching shapes combine",
    body: "Throw two same-type shapes into each other and the bigger one absorbs the smaller. Two sticky notes blend their colors instead.",
  },
  {
    title: "Rewind with Time Travel",
    body: "Every change is recorded - scrub back through the board's whole history any time from the header.",
  },
  {
    title: "Export anything",
    body: "Save the whole board, or just one selected object, as a PNG, SVG, or JSON file.",
  },
];

// localStorage can throw (Safari private mode with storage disabled,
// browser settings blocking site data, a full quota, or the site
// embedded in an iframe with storage access denied) rather than just
// returning null - an uncaught throw here would blank the whole app,
// not just skip onboarding. These wrappers turn "storage broken" into
// "treat the tip as unseen / silently skip persisting it" instead.
function hasSeenOnboarding() {
  try {
    return Boolean(localStorage.getItem(STORAGE_KEY));
  } catch {
    return false;
  }
}

function markOnboardingSeen() {
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // Storage unavailable - the tip will just show again next visit,
    // which is a fine fallback for a one-time hint.
  }
}

export default forwardRef(function Onboarding(_props, ref) {
  const [visible, setVisible] = useState(false);
  const dismissButtonRef = useRef(null);

  useEffect(() => {
    if (!hasSeenOnboarding()) {
      setVisible(true);
    }
  }, []);

  // Lets Room.jsx's header Help button reopen these tips any time,
  // not just on a brand-new browser - dismissing the one-time
  // auto-show shouldn't mean losing access to the tips for good.
  // Doesn't touch localStorage: reopening manually isn't "seeing it
  // for the first time" again, and shouldn't reset that flag.
  useImperativeHandle(ref, () => ({
    open: () => setVisible(true),
  }));

  const dismiss = () => {
    markOnboardingSeen();
    setVisible(false);
  };

  // Lock background scroll, close on Escape, and put focus on the
  // dismiss button while the overlay is up - all scoped to the
  // effect's own cleanup so nothing leaks if the component unmounts
  // (e.g. leaving the room) while it's still showing.
  useEffect(() => {
    if (!visible) return;

    dismissButtonRef.current?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (e) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!visible) return null;

  return (
    <div
      className="onboarding-overlay"
      onClick={(e) => {
        // Only the backdrop itself, not clicks bubbling up from the
        // card, should dismiss - otherwise selecting tip text would
        // accidentally close it.
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      <div
        className="onboarding-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-heading"
      >
        <p className="eyebrow">Welcome to InfiniVerse</p>
        <h2 id="onboarding-heading">A few things worth knowing</h2>
        <ul className="onboarding-tips">
          {TIPS.map((tip, i) => (
            <li key={tip.title}>
              <span className="onboarding-tip-number">{i + 1}</span>
              <div>
                <strong>{tip.title}</strong>
                <p>{tip.body}</p>
              </div>
            </li>
          ))}
        </ul>
        <button
          ref={dismissButtonRef}
          className="primary onboarding-dismiss"
          onClick={dismiss}
        >
          Got it, let's draw
        </button>
      </div>
    </div>
  );
});
