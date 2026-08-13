"use client";

// The one control the Database pane is built from: a labeled row, then N
// segments, strictest on the left.
//
// Both lists use it, which is the point. Table access and write rules used to
// be different-looking controls with different vocabularies ("deny/read/write"
// vs "block/allow" vs "run/approve"), so precedence between them had to be
// explained in prose. Rendering them as one control with position carrying
// strictness means the reader can see it instead: further left is stricter.
//
// Every selected segment gets the same two things, so none is the odd one out:
//
//   a 2px underline   at the foot of the cell — the mark that says "this one".
//   a fill            escalating in one hue, strictest on the left.
//
// Each cell's underline is a stronger version of its own fill, so the pair
// always agrees: neutral fill takes a neutral rule, amber fills take amber
// rules that brighten toward the permissive end. The floor having no rule was
// the bug — the two lower steps sit within 1.7% of each other in luminance, so
// Refuse read as unmarked next to Ask and the set looked like three unrelated
// treatments rather than one control.
//
// Not the 3px inset BRAND rail: that means "this is the selected item" in
// sidebars and single radio cards, and one per row down a ten-row pane turns a
// spec sheet into a scoreboard. This underline is per-cell furniture, in the
// cell's own hue.
//
// The whole cell is the click target (a label wrapping an sr-only radio), so
// the row works with a pointer, a keyboard, and a screen reader without any
// custom key handling.

import { cn } from "@/lib/utils";

/** Named for position on the ramp, not for meaning. A row that mapped its
 *  middle option to `permissive` would read as obviously wrong at the call
 *  site. */
export type SegmentTone = "restrictive" | "moderate" | "permissive";

const SELECTED: Record<SegmentTone, string> = {
  restrictive:
    "bg-foreground/10 text-foreground shadow-[inset_0_-2px_0_hsl(var(--foreground)/0.35)]",
  moderate:
    "bg-warn/[0.14] text-foreground shadow-[inset_0_-2px_0_hsl(var(--warn)/0.5)]",
  // Amber text as well as fill and rule at the top of the ramp — an over-grant
  // should pop down the column, which is the thing this pane is scanned for.
  permissive: "bg-warn/[0.22] text-warn shadow-[inset_0_-2px_0_hsl(var(--warn))]",
};

export function PolicySegment({
  label,
  tone,
  selected,
  groupName,
  rowLabel,
  onSelect,
}: {
  label: string;
  tone: SegmentTone;
  selected: boolean;
  /** Unique per row, so native radio grouping (arrow-key nav) stays
   *  row-scoped. The saved payload is built from React state, not these field
   *  names, so the names are free to be per-row. */
  groupName: string;
  rowLabel: string;
  onSelect: () => void;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center justify-center border-l border-border px-2 py-2 text-center text-sm transition-colors",
        selected
          ? cn("font-medium", SELECTED[tone])
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <input
        type="radio"
        name={groupName}
        value={label.toLowerCase()}
        checked={selected}
        onChange={onSelect}
        aria-label={`${rowLabel}: ${label}`}
        className="sr-only"
      />
      {label}
    </label>
  );
}
