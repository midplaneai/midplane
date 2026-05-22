import Link from "next/link";

import { cn } from "@/lib/utils";

// The wordmark *is* the mark on light/auth chrome. Renders as inline text so
// it scales with the user's font size, supports selection, and announces as
// "midplane" to screen readers (the colon is decorative).
//
// On dark surfaces, pass `onDark` so the letters invert to paper while the
// colon stays blue. The colon color is driven by .mp-colon in globals.css.
export function Wordmark({
  className,
  onDark,
  href = "/",
  size = "md",
}: {
  className?: string;
  onDark?: boolean;
  href?: string | null;
  size?: "sm" | "md" | "lg";
}) {
  const sizeClass =
    size === "lg" ? "text-2xl" : size === "sm" ? "text-sm" : "text-lg";
  const body = (
    <span
      className={cn(
        "mp-wordmark inline-flex items-baseline",
        sizeClass,
        onDark && "mp-on-dark",
        className,
      )}
    >
      mid<span className="mp-colon">:</span>plane
    </span>
  );
  if (!href) return body;
  return (
    <Link href={href} aria-label="midplane" className="inline-flex">
      {body}
    </Link>
  );
}

// Compatibility alias — used by sign-in / sign-up / region-picker chrome.
export const BrandLockup = Wordmark;
