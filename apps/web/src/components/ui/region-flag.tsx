import { cn } from "@/lib/utils";
import type { Region } from "@midplane-cloud/kms";

// Small inline region flags for the region picker. Drawn as SVG rather than
// emoji (🇪🇺 / 🇺🇸) on purpose: regional-indicator emoji don't render on
// Windows Chrome — they degrade to the letters "EU" / "US", which looks broken
// next to a data-residency trust signal. SVG renders identically everywhere.
//
// Decorative — the region name label sits beside it, so these are aria-hidden.
export function RegionFlag({
  region,
  className,
}: {
  region: Region;
  className?: string;
}) {
  const shared = cn(
    "h-4 w-6 shrink-0 rounded-[3px] ring-1 ring-border",
    className,
  );
  return region === "eu" ? (
    <EuFlag className={shared} />
  ) : (
    <UsFlag className={shared} />
  );
}

// EU: 12 gold stars in a circle on a blue field (official #003399 / #FFCC00).
// Ratio 3:2. Stars are small dots — at this size a 5-point star is
// indistinguishable from a dot, and dots stay crisp.
const EU_STARS = Array.from({ length: 12 }, (_, i) => {
  const theta = (-90 + i * 30) * (Math.PI / 180);
  return { cx: 30 + 12 * Math.cos(theta), cy: 20 + 12 * Math.sin(theta) };
});

function EuFlag({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 60 40"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect width="60" height="40" fill="#003399" />
      {EU_STARS.map((s, i) => (
        <circle key={i} cx={s.cx} cy={s.cy} r="2" fill="#FFCC00" />
      ))}
    </svg>
  );
}

// US: 13 stripes + a blue canton with a scatter of white stars. Stripes and
// stars are simplified to read at ~24px wide (official colors #B22234 /
// #3C3B6E). Ratio matched to the EU flag (3:2) so the two cards align.
const STRIPE_H = 40 / 13;
const WHITE_STRIPES = [1, 3, 5, 7, 9, 11];
const CANTON_W = 24;
const CANTON_H = STRIPE_H * 7;
const US_STARS = [4, 9.6, 15.2, 20.8].flatMap((cx) =>
  [5.4, 10.8, 16.2].map((cy) => ({ cx, cy })),
);

function UsFlag({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 60 40"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect width="60" height="40" fill="#B22234" />
      {WHITE_STRIPES.map((i) => (
        <rect key={i} y={i * STRIPE_H} width="60" height={STRIPE_H} fill="#fff" />
      ))}
      <rect width={CANTON_W} height={CANTON_H} fill="#3C3B6E" />
      {US_STARS.map((s, i) => (
        <circle key={i} cx={s.cx} cy={s.cy} r="1.1" fill="#fff" />
      ))}
    </svg>
  );
}
