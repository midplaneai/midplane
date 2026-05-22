"use client";

// Cycling agent name in the close-band headline. Renders "Claude" on
// first paint (matches SSR output), then after mount rotates through
// Claude / Cursor / Codex with a quick opacity dip between swaps.
//
// Width is locked to the widest name via an invisible width-holder
// span so the headline doesn't reflow as the word changes — the
// visible name is absolutely positioned on top.
//
// Honors prefers-reduced-motion: if the user has motion reduced,
// the headline freezes on "Claude" with no cycle.

import { useEffect, useState } from "react";

const AGENTS = ["Claude", "Cursor", "Codex"] as const;
const WIDEST = AGENTS.reduce((a, b) => (a.length >= b.length ? a : b));
const SWAP_MS = 2400;
const FADE_MS = 220;

export function CyclingAgent() {
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mq.matches) return;

    let fadeTimer: ReturnType<typeof setTimeout> | undefined;
    let swapTimer: ReturnType<typeof setTimeout> | undefined;

    const tick = () => {
      setVisible(false);
      fadeTimer = setTimeout(() => {
        setIndex((i) => (i + 1) % AGENTS.length);
        setVisible(true);
        swapTimer = setTimeout(tick, SWAP_MS);
      }, FADE_MS);
    };

    swapTimer = setTimeout(tick, SWAP_MS);

    return () => {
      if (fadeTimer) clearTimeout(fadeTimer);
      if (swapTimer) clearTimeout(swapTimer);
    };
  }, []);

  return (
    <span className="cycling-agent">
      <span className="cycling-agent-hold" aria-hidden>
        {WIDEST}
      </span>
      <span
        className="cycling-agent-shown"
        data-visible={visible}
        aria-live="polite"
      >
        {AGENTS[index]}
      </span>
    </span>
  );
}
