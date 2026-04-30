import { cn } from "@/lib/utils";

interface BrandMarkProps {
  className?: string;
  size?: number;
}

export function BrandMark({ className, size = 18 }: BrandMarkProps) {
  return (
    <span
      aria-hidden
      className={cn("inline-block bg-foreground", className)}
      style={{
        width: size,
        height: size,
        clipPath: "polygon(0 0, 100% 0, 100% 65%, 65% 100%, 0 100%)",
      }}
    />
  );
}

export function BrandLockup({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-sm font-semibold tracking-[-0.01em] text-foreground",
        className,
      )}
    >
      <BrandMark />
      midplane
    </span>
  );
}
