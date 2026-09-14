# Engineering notes

This is the full build log for InfiniVerse (Collaborative Canvas): every part of
the build broken down individually, what was verified, the reasoning behind
each design decision, and every real bug found and fixed along the way. It's
kept separate from the top-level [README](../README.md) so that file can stay
a quick, scannable overview while this one keeps the detail.

## Status

**Part 1: WebSocket relay** - done and tested
- `/ws/{room_id}` endpoint, in-memory per-room connection registry
- Broadcasts binary frames (Yjs updates/awareness) and text frames
  (control messages) to everyone else in the room
- Every raw Yjs update ever relayed through a room is also kept in an
  in-memory history and replayed to each new/reconnecting client -
  this means a lone new joiner (no other live peers) still sees
  existing content immediately, not a blank canvas. Known, deliberate
  limitation: this history lives only in the backend process's
  memory, so it's lost on a restart and grows unboundedly for the
  life of a room - fine for a demo-length session, not a real
  persistence layer.

**Part 2: REST + Postgres** - done and tested
- Room creation/lookup (with an optional custom room name), file
  upload endpoints
- Postgres persistence via SQLAlchemy (async)

**Part 3: Frontend** - working, verified end-to-end
- Room creation/joining, live drawing sync between tabs (Yjs + IndexedDB)
- Offline reconciliation - drawing keeps working with zero network via
  the IndexedDB cache; on reconnect, the client resends its full local
  doc state (catching everyone else up on anything drawn while
  offline) and the backend replays its own history back to the
  client (catching it up on anything others drew in the meantime).
  Because Yjs is a CRDT, both directions merge automatically with no
  conflicts to resolve and no reconciliation UI needed by design -
  this isn't a partial version of the stretch goal, it's the whole
  thing.
- Pan (hold Space + drag, or middle-click drag) and zoom (scroll wheel,
  anchored to the cursor) - strokes are stored in world coordinates so
  they stay correctly placed regardless of camera position
- Two-finger pinch-to-zoom on touch devices, anchored to the pinch
  midpoint (same anchoring math as the desktop Ctrl/Cmd+scroll zoom) -
  this closes a real, significant gap that predates this specific
  addition: zoom was previously 100% wheel-event-based, and
  touchscreens have no wheel events, so "smooth zoom & pan" (a
  mandatory part of the brief) plainly didn't work via touch gesture
  on mobile at all until this was added
- Recenter button (toolbar) - zooms/pans to fit all current content
  back into view, or resets to the origin if the board is empty
- Fixed: new joiners now receive a `room_state` message listing everyone
  already in the room, so peer counts match on both sides (previously a
  new joiner always started at 0 regardless of who else was present)
- Room name shown in the header (falls back to "Untitled room"),
  alongside a connection-status dot (hover for Connected/Disconnected)
  and a "so-and-so has entered the room" toast on each join
- Current-user tag in the header (colored avatar + name) and a
  matching colored avatar tag per peer on the mini-map - colors are
  generated per-connection (not per-username), so two people sharing
  a name still get visually distinct tags instead of colliding into
  one. Hover or tap a mini-map tag to see that person's name.

**Part 4: Object types (pen, rectangle, ellipse, triangle, star, arrow,
text, sticky notes, audio, images)** - done, build verified
- Floating toolbar to switch tools; each object type is a plain JS
  object with a `type` discriminator in the shared Yjs map - adding
  a new type going forward means a new render branch + a new pointer
  handler branch, nothing about sync/persistence/pan-zoom changes
- Old stroke data without a `type` field still renders correctly
  (treated as `type: "stroke"`)
- Text is edited inline via a textarea overlaid directly on the canvas
  at the shape's on-screen position (same editing mechanism sticky
  notes use) - not `window.prompt()`, which was only ever a
  placeholder during early development
- Sticky notes (colored, resizable) and inline audio recording/
  playback are both implemented alongside the original four types
- Triangle, star, and arrow were added later, reusing the same
  drag-to-size mechanic as rectangle/ellipse - arrow is the one
  exception, since it needs to remember which direction it was drawn
  in rather than always normalizing to a top-left-anchored box like
  every other shape (see Part 9 for why it's also excluded from
  resizing specifically)

**Part 5: Images** - done, build verified
- Toolbar has an "Image" button that opens a native file picker,
  uploads via the existing `/rooms/{id}/uploads` endpoint from Part 2,
  then places the image as a `type: "image"` object wherever the
  user is currently looking on the canvas (not a fixed corner - pan/
  zoom means there's no single "corner" anymore)
- Images are capped to 320px on their longest side (aspect-ratio
  preserved) so a huge photo doesn't dominate the canvas by default
- Upload errors (wrong file type, too large, room not found) surface
  as a small toast rather than failing silently
- Shift+click an image to mark it for bulk download; images and audio
  clips can also be bulk-downloaded via the Export menu

**Part 6: Export** - done, build verified
- Export menu covers PNG (full board, including shapes currently
  panned off-screen), SVG (hand-written per-shape mapping, no
  external library), raw JSON, and audio clips (downloaded in
  whatever format the browser actually recorded in)
- Individual shapes can also be exported on their own - see Part 11

**Part 7: Mini-map** - done, build verified
- Fixed overview panel (bottom-right) showing every shape on the
  board, a rectangle for your own current viewport, and an avatar tag
  for every other connected user's current viewport
- Peers who haven't panned away from the same starting view are
  fanned out instead of stacking into what would otherwise look like
  a single overlapping tag
- A peer's tag is kept alive by a periodic heartbeat and dropped if
  we haven't heard from them in a while (~10s) - this covers a
  crashed tab or dropped connection, not just a clean "left the room"

**Part 8: Time Travel** - done, build verified
- "Time Travel" button in the header opens a modal that replays a
  room's entire session: fetches every raw update ever relayed
  through the room (`GET /rooms/{room_id}/history`, each tagged with
  a wall-clock timestamp), applies them one at a time into a
  throwaway Y.Doc, and snapshots the board's shapes after each one
- Starts at the beginning of the session (not the end), with a
  scrubber plus Play/Pause and an adjustable speed (0.5x/1x/2x/4x)
- Camera is fully manual - drag or scroll to pan, Ctrl/Cmd+scroll to
  zoom, same gesture set as the live canvas - rather than auto-fitting
  per scrub step. That was tried first and didn't work: fitting to
  only the current step's shapes made early steps unreadably tiny
  once more content existed by the end, and there's no way around
  needing to zoom out once everything that will ever exist, exists. A
  Recenter button reframes to whatever's on the board at the current
  step whenever you want it, on your own terms
- Read-only rendering, separate from the live editing canvas - no
  drag/resize/select handlers, and audio clips show as a static icon
  rather than being played back
- Same in-memory-only caveat as Part 1: replay only covers what the
  current backend process has seen since it last restarted

**Part 9: Physics and interactions** - done, build verified
- Objects can be thrown (a fast drag-release "flick," not a separate
  tool), collide with each other, and be pulled together or pushed
  apart via two one-off toolbar actions, Attract and Repel (same
  "acts on what you're currently looking at" pattern as Recenter)
- Custom, dependency-free physics (`frontend/src/usePhysics.js`)
  rather than matter.js - a deliberate choice, not a fallback: the
  brief explicitly allows either, and a hand-written system avoids
  depending on an external package that isn't guaranteed to be
  installable/verifiable in every environment this gets built in
- Scope: rect, ellipse, triangle, star, arrow, sticky, image, and
  audio can all be thrown and collide; freehand strokes and text are
  excluded (neither has a natural axis-aligned box to collide against)
- A deliberate set of type-based rules, not just generic elastic
  collision, applying only to rect/ellipse/triangle/star/sticky
  (images, audio, and arrows always just bounce, never trigger a
  special rule):
  - two shapes of the identical type (rect+rect, ellipse+ellipse,
    triangle+triangle, star+star): the bigger one survives and grows
    (area-additive - "becomes bigger if there's a difference in
    size"), the smaller one is deleted. Fixed a real bug here: growth
    only ever applied when the shape doing the throwing happened to be
    the winner - if the stationary shape was bigger, it was correctly
    kept but never actually grew, so the survivor's size didn't
    reflect what it had just absorbed. Now both directions grow
    correctly, regardless of which shape was in motion
  - sticky+sticky: both survive, colors blend to the same new color -
    kept separate (not merged into one) since two notes can have
    entirely different text/content
  - rect/ellipse/triangle/star + sticky: the shape is deleted, and
    the sticky "takes" that outline (a `shapeKind` field) regardless
    of which of the four it was
  - two different SPECIAL types (e.g. rect vs ellipse, rect vs
    triangle): no special rule, just a normal bounce
- Arrows are excluded from resizing (not just the merge rules) - the
  generic resize-handle logic normalizes width/height to positive
  values, which would silently flatten every arrow to the same
  down-right diagonal after a resize, since an arrow's width/height
  are signed on purpose (they encode which way it points)
- Position updates while a shape is in motion are throttled (synced
  to Yjs a few times a second via a directly-tracked "true position"
  ref, not every single frame) - not the original design. Calling
  updateShape() on every frame (matching how ordinary dragging already
  works) got noticeably less smooth once rotation Group wrappers and
  zIndex-sorted render order piled more cost onto every full re-render
  - separating "what the thrower sees locally" (still a smooth 60fps,
  via directly repositioning the shape's own Konva node every frame)
  from "what gets synced to everyone else" (throttled) fixed that,
  at the cost of other people now seeing a thrown object update at
  roughly 11 times a second instead of 60 while it's still moving -
  a fair trade for a meaningfully smoother throw locally
- That same direct-node-repositioning trick introduced its own bug:
  every physics-eligible shape's top-level node is wrapped in a
  rotation Group whose x/y/offsetX/offsetY are all set to the shape's
  CENTER (that's what makes rotation pivot around the middle instead
  of the corner - see Part 10). Positioning that node using the raw
  top-left coordinates everywhere else in the app uses shifted the
  whole thing by roughly half its own width/height from where it
  should be - visible as thrown shapes appearing to drift outside
  their own bounding box (worse for audio chips specifically, whose
  Group had no rotation wrapper at all, so the same call added the
  new position on top of the already-absolute child coordinates
  instead of replacing them). Fixed by converting top-left to center
  before positioning, and giving audio the same rotation-Group
  convention every other shape already had (a no-op for its actual
  appearance today, since audio has no rotation control and always
  renders at 0°, but necessary for the coordinate math to line up)
- Every SPECIAL_TYPES shape kind (rect/ellipse/triangle/star) can now
  become a sticky note's outline via the absorb rule, not just
  rect/ellipse - the earlier scope trim excluding triangle/star meant
  absorbing one visibly did nothing (the shape vanished, the sticky
  looked unchanged, which reads as "just disappearing" rather than
  "being absorbed"). Triangle/star now have their own approximate
  (not mathematically exact - a much harder problem for a
  non-rectangular shape) inscribed text-safe areas, reused
  consistently by the live canvas, SVG export, and Time Travel replay
  via one shared `stickyTextBox()` helper
- Fixed a real glitch in sticky+sticky color blending: the "blended"
  outcome never separated the two notes afterward, so if they were
  still overlapping on the next frame (which they usually were,
  nothing was pushing them apart), the exact same blend re-triggered
  every single frame for as long as contact lasted - harmless to the
  end result (blending an already-matching color with itself is a
  no-op) but wastefully repeated, which is what actually caused the
  stutter. Blended pairs now fall through to the same separation
  physics as a plain bounce, so contact resolves in one frame instead
  of lingering
- Known limitation, stated plainly rather than hidden: each connected
  client runs its own local simulation, and only the person who threw
  an object is authoritative for its motion (broadcasting position the
  same way a live drag already does). If two different people throw
  two different objects into each other at the same instant, the
  resulting collision is an approximation rather than one
  server-agreed outcome - full server-authoritative physics was out of
  scope for a 2-day build

**Part 10: Style panel and content-creation polish** - done, build verified
- A Figma-style properties panel slides in from the left automatically
  whenever a shape is selected, and slides back out on deselect - no
  button to find, matching how design tools actually behave.
- Panel controls, scoped to whichever fields are actually relevant to
  the selected shape's type:
  - Color (a palette plus a native color picker for anything custom)
  - Stroke width (outlined shapes) or Pen width (freehand strokes)
  - Rotation (rect/ellipse/triangle/star/arrow/sticky/image) - a
    Konva Group-offset trick rotates each shape around its own center
    rather than its corner. Deliberately visual-only: hit-testing,
    dragging, resizing, and physics collision all still use the
    un-rotated bounding box, so a heavily-rotated shape's clickable
    area may not perfectly match what's drawn - a real rotated-AABB
    implementation would touch far more of the app than this
    "cheap win" warranted, so this is a documented trade-off, not an
    oversight
  - Every slider (Rotation, Font size, Stroke width, Pen width) is
    paired with a plain number input, not slider-only - dragging is
    fast for rough adjustments, but there was previously no way to
    type an exact value. Each is labeled with its actual unit ("px"
    for size/width, "°" for rotation) and accepts what that unit
    actually means: rotation runs -180 to 180 (typing a negative
    number is a more natural way to say "a quarter-turn
    counter-clockwise" than typing 270), while size/width fields are
    positive-only
  - Fixed a real bug in these number inputs: the min/max bound was
    being enforced on every keystroke, not just the final value - so
    typing "12" digit by digit into a field with a minimum of 10 was
    actually impossible, since the field clamped up to 10 the instant
    it held just "1", before a second digit could ever be typed. The
    input now tracks its own text while being typed into and only
    clamps once you're done (on blur or Enter), so typing any
    in-range value works normally, while the value you end up with
    still can't exceed the bound
  - Font size, font family (Inter / Space Grotesk / JetBrains Mono -
    only fonts the app actually loads, so nothing silently falls
    back), Bold, Italic (text and sticky notes)
  - Alignment (sticky notes only - plain "text" shapes have no fixed
    width for text to align within, so the control would visibly do
    nothing there)
  - Bring to Front / Send to Back - a plain numeric `zIndex` field,
    sorted at render time; shapes without one default to 0 and simply
    keep their natural creation-order position among each other
  - Duplicate - clones the shape with a small offset, brought to the
    front; handles freehand strokes specially (shifting every point
    in their `points` array) since strokes have no single x/y to
    offset
- Kept permanently mounted rather than conditionally rendered so it
  can animate its own disappearance, not just its appearance -
  unmounting on deselect would give a CSS transition zero time to play
- Also hides itself automatically the moment a selected shape starts
  actually being dragged (in particular, thrown) - it used to stay
  open the whole time, which meant the very thing you're trying to
  watch move could end up sitting right underneath it. Reappears the
  instant you let go. A plain click-to-select still opens it
  immediately, same as before - only genuine movement past the same
  click-vs-drag threshold used elsewhere in the app triggers the hide,
  so quick edits aren't affected
- That fix only covers movement, though - a shape that simply lives
  near the left edge would still sit fully underneath the panel the
  instant you click to select it, no drag involved at all. Fixed
  separately: the panel now sits at reduced opacity by default while
  a shape's selected, and only returns to full clarity on hover (or
  focus, for touch, where hover doesn't reliably apply) - so it's
  never fully hiding whatever's underneath, but is fully readable the
  moment you actually mean to use it
- The custom color swatch (the native color-picker input) used to be
  visually identical to a preset swatch - picking black manually, for
  instance, looked exactly like the black preset already in the
  palette, with nothing marking it as "pick anything" rather than
  "this is just another preset." Now has a small "+" badge overlaid
  on it
- Rotation, layer order, and typography are mirrored consistently
  across the live canvas, SVG export, and Time Travel replay - not
  just the live view
- The five shape tools (rectangle/ellipse/triangle/star/arrow), which
  had briefly each gotten their own permanent toolbar icon, were
  consolidated into a single "Shapes" flyout button - matching how
  Figma and similar tools actually handle this, and the more durable
  pattern generally: a new shape type shouldn't mean a new permanent
  icon forever. Attract and Repel were merged the same way, into a
  single "Physics" flyout, since two closely-related one-off actions
  don't each need their own permanent slot either
- The Attract/Repel/Physics icons went through two redesigns before
  landing somewhere legible - a magnet-shaped attempt read as
  headphones at 20px, and a follow-up with circles-plus-arrows still
  didn't read as arrows. Settled on plain converging/diverging chevron
  pairs for Attract/Repel (mirror images of each other - arrowheads
  pointing at each other vs. away from each other, no extra
  metaphor to parse) and a plain atom symbol for the Physics flyout
  trigger itself
- Sticky note text now fits properly when a sticky has taken an
  ellipse outline via the physics absorb rule (see Part 9) -
  previously the text kept the same rectangular padding regardless of
  background shape, so its corners poked outside the curve. Fixed
  using the largest axis-aligned rectangle that actually fits inside
  an ellipse of that width/height (inset to width/height divided by
  √2, centered)
- Time Travel now coalesces updates recorded within ~500ms of each
  other into a single step, rather than treating every single raw
  update as its own step. Ordinary dragging (and pen strokes) call
  updateShape on every pointer-move tick unthrottled, so one two-second
  drag alone used to produce 60+ near-identical Time Travel steps -
  now that same drag collapses into one step showing its end result,
  while two genuinely separate actions with a real pause between them
  still stay as two steps
- Throw physics retuned after actually running the numbers: the
  original friction constant meant a typical throw traveled roughly 2x
  its initial speed in total distance and took ~10 seconds to fully
  stop. Retuned so a typical throw now travels ~15-25% of its initial
  speed and settles in under 2 seconds

**Part 11: Per-object export and a mobile pass** - done, build verified
- Any individual object (any shape, sticky note, or image) can be
  exported on its own as PNG, SVG, or JSON, via three buttons in the
  style panel - separate from the whole-board export in the header
- PNG reuses the exact same "temporarily reposition the Stage to
  frame specific bounds" technique the whole-board export already
  uses, just framed to one shape's bounds with every other shape's
  node hidden for the snapshot (every top-level shape node carries a
  shared `"shape-node"` name for exactly this purpose). This replaced
  an earlier attempt that called Konva's per-node `toDataURL()`
  directly - which sounds like it should "just work," but Konva
  Groups (which is what almost every shape is now, due to the
  rotation wrapper - see Part 10) have no intrinsic width/height the
  way a Rect or Image does, so that would likely have produced a
  blank or wrongly-cropped image for most shape types rather than
  the clean crop it looked like it was doing
- SVG reuses the whole-board serializer (`shapesToSVG()`) with a
  single-shape array, since it already computes cropping/offsets
  generically for whatever shapes it's given; JSON is a plain
  `JSON.stringify()` of that one shape
- Fixed a real, pre-existing bug surfaced while building this: images
  are loaded without `crossOrigin` set, which means the browser
  fetches them in plain (non-CORS) mode even though the backend
  already sends permissive CORS headers - and a canvas that's drawn a
  cross-origin image loaded that way is "tainted," so `toDataURL()`
  throws a SecurityError the moment it's called. This would have hit
  the *existing* whole-board PNG export too, not just the new
  per-object one, any time an image was on the board - fixed by
  setting `crossOrigin` before the image starts loading
- Added two-finger pinch-to-zoom to both the live canvas (see Part 3)
  and the Time Travel replay modal (which only had desktop Ctrl/Cmd+
  scroll zoom until now) - the most significant findings from an
  explicit mobile-behavior check, since zoom was otherwise 100%
  wheel-based and therefore didn't work via touch at all in either
  place
- Fixed a bug in the toolbar's own overflow handling: `overflow-x:
  auto` (added to fit 14 buttons before the Shapes flyout
  consolidation) would have clipped the flyout's own dropdown, since
  setting overflow on one CSS axis forces the other axis to clip too.
  Replaced with `flex-wrap`, which sidesteps the conflict entirely and
  is arguably better mobile behavior anyway - nothing hidden behind a
  scroll a person has to discover
- The header bar (room name, Copy ID, Export, Time Travel, peer
  count, etc.) had no overflow handling of any kind - on a narrow
  phone it would have either clipped content or forced page-wide
  horizontal scroll. Now scrolls horizontally within itself instead,
  same reasoning as the toolbar fix above but via `overflow-x`
  (there's no dropdown escaping the header's bounds the way the
  Shapes flyout does, so the axis-clipping conflict that ruled this
  out for the toolbar doesn't apply here)
- The style panel becomes a bottom sheet on narrow screens instead of
  a left sidebar - a fixed-width (or even viewport-relative-width)
  panel eating into one side of a ~375px phone screen while editing a
  shape is cramped either way; sliding up from the bottom is the more
  natural mobile pattern (thumb-reachable, doesn't compete with
  landscape-oriented canvas panning) and scales to any screen width
  for free

**Part 12: A UI/UX pass** - done, build verified
- Shareable invite links: the header's "Copy ID" button is now
  "Invite," and copies a full URL (`?room=<id>` appended to wherever
  the app is hosted) rather than a bare ID someone has to paste by
  hand into the Join field. Opening that link skips the splash screen
  entirely (someone clicking an invite is trying to get INTO a room,
  not watch a loading animation) and lands straight on name entry with
  the room ID already filled in
- The style panel can now anchor to the RIGHT edge instead of the
  left, when the selected shape's current on-screen position (not
  just its world coordinates - this accounts for the current pan/zoom)
  falls within the panel's own width. Recomputed on every render, so
  it flips live as the shape or the camera moves, not just once at
  selection time. This replaced an earlier, different attempt at the
  same problem (fading the panel to 45% opacity until hovered) that
  was already in place - keeping both would have meant an unnecessary
  default-dimmed panel even in cases the flip now prevents outright,
  so the opacity workaround was removed rather than layered underneath
- Custom color swatch made more visually distinct from the preset
  palette - a dashed accent-colored border on the swatch itself
  (not just an overlay badge, which risked getting hidden behind the
  native color input's own internal rendering in some browsers),
  plus a bolder badge with an explicit stacking order
- The Physics flyout icon simplified from 3 overlapping orbit
  ellipses to 2 perpendicular ones - the extra ellipse created a
  moire-like pattern that read more as a gear or a flower than an atom
  at 20px
- Mini-map dims to 50% opacity when nobody else is in the room
  (checked via peerViewports being empty), since it's only earning
  its keep as a content overview at that point, not a presence
  indicator - and returns to full opacity automatically the moment
  someone joins
- A one-time onboarding overlay (`Onboarding.jsx`), shown on first
  visit to any room and dismissed permanently via a localStorage flag
  (per-browser, not per-account or per-room, matching how "auth" works
  everywhere else in this app). Uses plain numbered tips rather than
  new custom icons for each one - deliberately, given the
  Physics/Attract/Repel icons already went through two rounds of
  "this doesn't read as what it's supposed to be" without ever having
  been seen in a real browser; five more icons shipped the same way
  wasn't a risk worth taking for a first-run hint

**Part 13: Splash background** - done, build verified
- The splash screen now has a faint animated star layer behind the
  wordmark and shape animation, instead of a blank background - a nod
  to the app's name (InfiniVerse, from "infinite" + "universe"). Star
  positions are generated once on an evenly-spaced grid (so it still
  functionally reads as "canvas / graph paper," the same pattern most
  drawing tools use for their background) with per-dot randomized
  size, opacity, and twinkle timing layered on top (so it also reads
  as a starfield) - grid spacing keeps the "canvas" meaning, the
  jitter is what tips it toward "universe" without losing that
- Each star twinkles on its own independent animation cycle rather
  than all in sync, which is what actually sells "quiet starfield"
  over "blinking grid"
- The star layer sits behind the real splash content as a separate
  absolutely-positioned sibling. Content needed its own explicit
  `position: relative` stacking context to paint above it - a plain
  `position: absolute; z-index: 0` layer otherwise paints above
  non-positioned static content per CSS stacking order, the opposite
  of what's needed here
- The splash now runs a bit longer (3.8s → 5s) so the shape-drawing
  animation doesn't feel rushed, but it's also click/tap-to-skip
  (anywhere on the screen) so nobody's stuck sitting through it if
  they don't want to - a quiet "Tap to skip" hint sits at low opacity
  by default (touch devices don't reliably fire :hover, so it can't
  be hover-only) and brightens slightly on hover for desktop

**Part 14: Onboarding hardening** - done, build verified
- `localStorage` access wrapped in try/catch on both read and write -
  it can throw (not just return null) in Safari private mode, when a
  browser blocks site storage, on a full quota, or when the app is
  embedded in an iframe without storage access. Previously an
  uncaught throw here would have blanked the whole app rather than
  just skipping the onboarding check; now it degrades to "show the
  tip again next visit" instead
- Escape key dismisses the overlay, in addition to the button
- Clicking the dimmed backdrop dismisses it too - scoped to clicks
  that start on the backdrop itself (`e.target === e.currentTarget`),
  so selecting tip text and dragging outside the card doesn't
  accidentally close it
- Background page no longer scrolls while the overlay is open, and
  the scroll lock is restored via effect cleanup so it can't get
  stuck on if the component unmounts (leaving the room) while still
  showing
- Dismiss button gets focus automatically when the overlay opens, and
  the card now has `role="dialog"`, `aria-modal`, and
  `aria-labelledby` for screen readers

**Part 15: Fixed an infinite render loop** - done, build verified
- `useYjsRoom`'s `sendViewport`, `addShape`, `updateShape`, and
  `deleteShape` were plain functions, redefined with a new identity
  on every render, instead of being memoized. `sendViewport` in
  particular was the root cause of a genuine infinite render loop
  (visible in the console as repeated "Maximum update depth
  exceeded" warnings, not just noise): Room.jsx's `handleViewportChange`
  is a `useCallback` keyed on `[sendViewport]`, so a fresh
  `sendViewport` every render gave `handleViewportChange` a fresh
  identity too - which fed into Canvas.jsx's viewport-report effect
  (keyed on `[..., onViewportChange]`), which called `setOwnViewport`
  in Room.jsx on every one of those "changes," re-rendering Room,
  producing yet another fresh `sendViewport`, forever
- All four are now wrapped in `useCallback` with stable dependencies
  (`shapesMap` for the shape functions - itself stable via
  `useMemo` unless `roomId` changes; `username`/`clientId` for
  `sendViewport`, since `wsRef`/`lastViewportRef` are refs and don't
  need to be dependencies at all)
- This also fixes a secondary, lower-severity issue: Room.jsx's dev
  console helper (`__seedTestShapes`/`__clearTestShapes`) depended on
  `[addShape, deleteShape, username]` and was re-registering those
  window functions on every single render as a result - harmless
  functionally, but wasted work riding on the same bug

**Part 16: Reopenable onboarding + Help button** - done, build verified
- The one-time welcome tips were a dead end once dismissed - no way
  back in short of clearing localStorage. `Onboarding` is now a
  `forwardRef` component exposing an `open()` method via
  `useImperativeHandle`, and the header has a new "Help" button that
  calls it - reopens the exact same 5-tip card any time, on demand
- Reopening manually doesn't touch the `infiniverse-onboarding-seen`
  localStorage flag - only the actual dismiss button/Escape/backdrop
  click do that, so manually reopening it doesn't reset anything
  about the auto-show-on-first-visit behavior
- Went with this over adding contextual coach-mark tooltips next to
  each toolbar feature - that's more surface area (per-hint dismiss
  state, positioning against toolbar elements that already move
  around on mobile vs desktop per Part 11's responsive work) for a
  hackathon MVP, and doesn't solve "I dismissed it and it's gone"
  on its own the way a reopen button does directly. Worth revisiting
  later if the reopenable modal alone isn't enough

## Intentionally out of scope (documented, not forgotten)

Given the 2-day build window, these were deliberately left out:
- Room expiry / auto-deletion (manual delete only, planned as a future feature)
- S3/object storage (local disk is sufficient for this scale)
- Redis / multi-instance scaling (single backend process is enough here)
- Persisting the update history to Postgres - both the join/reconnect
  replay (Part 1) and Time Travel (Part 8) read from an in-memory list
  that's lost on a backend restart. This is the same single-process
  tradeoff already made everywhere else in this MVP, not a new one:
  making it durable means a new table plus a database write on every
  single draw/drag tick instead of an in-memory append, and it wasn't
  worth that cost against features actually asked for in the brief -
  nothing in scope needs it to survive a server restart mid-session
- Real user accounts - "auth" here is intentionally minimal: a typed
  username, passed straight through as a query param on the WebSocket
  connection and stored as-is on room creation. There's no password,
  no verification, and nothing stopping two people from typing the
  same name or one person impersonating another by reusing someone
  else's name - meets the spec's bar of "guest mode + username," but
  isn't a real session or security mechanism of any kind
