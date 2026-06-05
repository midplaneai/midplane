"use client";

import { useEffect, useState } from "react";

// Counts down `seconds` whole seconds once `active` becomes true, returning
// the number of seconds still remaining (0 once elapsed, and 0 whenever
// `active` is false). Used to gate the dismiss/"I've saved it" affordance on
// a show-once secret so the surface can't be fat-fingered away before the
// user has had a beat to copy it. See create-token-modal.tsx and the
// post-create page's SavedItButton.
export function useUnlockCountdown(active: boolean, seconds: number): number {
  const [remaining, setRemaining] = useState(active ? seconds : 0);

  useEffect(() => {
    if (!active) {
      setRemaining(0);
      return;
    }
    setRemaining(seconds);
    const id = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          clearInterval(id);
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [active, seconds]);

  return remaining;
}
