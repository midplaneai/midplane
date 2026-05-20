import { cn } from "@/lib/utils";

interface BrandMarkProps {
  className?: string;
  size?: number;
}

export function BrandMark({ className, size = 18 }: BrandMarkProps) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-block overflow-hidden bg-foreground",
        className,
      )}
      style={{ width: size, height: size, borderRadius: 4 }}
    >
      <span className="absolute inset-x-0 top-1/2 h-px bg-background" />
      <span className="absolute inset-y-0 left-1/2 w-px bg-background" />
    </span>
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
