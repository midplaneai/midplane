import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

// Buttons are the one rectangular surface that keeps a radius (6px).
// Matches the landing's .ebtn so primary CTAs on /dashboard and / read as
// the same control. The icon variant stays round (rounded-full).
const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-[6px] text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none",
  {
    variants: {
      variant: {
        // `border-transparent` reserves the 1px so disabled (dashed
        // border) doesn't shift adjacent layout when toggled.
        default:
          "border border-transparent bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-transparent disabled:text-subtle disabled:border-dashed disabled:border-border-strong",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50",
        outline:
          "border border-input bg-background hover:bg-accent hover:text-accent-foreground disabled:opacity-50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50",
        ghost: "hover:bg-accent hover:text-accent-foreground disabled:opacity-50",
        link: "text-primary underline-offset-4 hover:underline disabled:opacity-50",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 px-3",
        lg: "h-11 px-8",
        icon: "h-10 w-10 rounded-full",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  // Opt-in arrow suffix for primary CTAs (mirrors landing hero CTA).
  // Not on every button — too loud. Pass on form submits.
  arrow?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, arrow, children, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    >
      {children}
      {arrow && (
        <span aria-hidden className="ml-2.5 font-mono">
          →
        </span>
      )}
    </button>
  ),
);
Button.displayName = "Button";

export { Button, buttonVariants };
