import { cn } from "@/lib/utils";

// The product-voice micro-label (DESIGN.md "Voice split"): lowercase mono,
// 11.5px, tracking 0.04em, tertiary color. Section eyebrows, rail labels,
// and other in-app micro headings render through THIS primitive instead of
// re-inlining the class string — the 2026-07-08 eyebrow normalization
// happened precisely because inlined copies drifted (case AND tracking).
// `block` so it stacks like a heading regardless of the host container.

export function SectionLabel({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "block font-mono text-[11.5px] font-medium lowercase tracking-[0.04em] text-subtle",
        className,
      )}
    >
      {children}
    </span>
  );
}
