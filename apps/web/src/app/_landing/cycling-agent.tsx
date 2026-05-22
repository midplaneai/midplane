// Cycles through agent names in the close-band headline. All names
// are rendered into the DOM at once; pure CSS @keyframes toggles
// which one is visible at any moment, so there's no React state,
// no useEffect, and no hydration jitter — the animation runs from
// the moment the CSS loads, identically across Chrome / Safari /
// Firefox.
//
// Honors prefers-reduced-motion via @media query in globals.css:
// the animation is suppressed and the first name (Claude) stays
// visible. Width is locked to the widest name via an invisible
// width-holder so the headline doesn't reflow between swaps.

const AGENTS = ["Claude", "Cursor", "Codex"] as const;
const WIDEST = AGENTS.reduce((a, b) => (a.length >= b.length ? a : b));
const HOLD_MS = 2400;

export function CyclingAgent() {
  const cycleMs = AGENTS.length * HOLD_MS;
  return (
    <span className="cycling-agent">
      <span className="cycling-agent-hold" aria-hidden>
        {WIDEST}
      </span>
      {AGENTS.map((name, i) => (
        <span
          key={name}
          className="cycling-agent-item"
          style={{
            animationDelay: `${i * HOLD_MS}ms`,
            animationDuration: `${cycleMs}ms`,
          }}
          aria-hidden={i > 0}
        >
          {name}
        </span>
      ))}
    </span>
  );
}
