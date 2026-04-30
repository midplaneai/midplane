import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-[3px] border px-1.5 py-[2px] font-mono text-[10px] font-medium uppercase tracking-[0.04em]",
  {
    variants: {
      variant: {
        default:
          "border-border bg-secondary text-muted-foreground",
        accent:
          "border-[hsl(var(--brand)/0.2)] bg-[hsl(var(--brand)/0.08)] text-[hsl(var(--brand))]",
        allow:
          "border-[hsl(var(--allow)/0.2)] bg-[hsl(var(--allow)/0.08)] text-[hsl(var(--allow))]",
        deny:
          "border-[hsl(var(--deny)/0.2)] bg-[hsl(var(--deny)/0.08)] text-[hsl(var(--deny))]",
        warn:
          "border-[hsl(var(--warn)/0.2)] bg-[hsl(var(--warn)/0.08)] text-[hsl(var(--warn))]",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  withDot?: boolean;
}

function Badge({
  className,
  variant,
  withDot = true,
  children,
  ...props
}: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {withDot && variant && variant !== "default" && (
        <span
          aria-hidden
          className="h-1 w-1 rounded-full bg-current"
        />
      )}
      {children}
    </span>
  );
}

export { Badge, badgeVariants };
