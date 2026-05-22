import * as React from "react";

import { cn } from "@/lib/utils";

// Form-field labels in the product runtime voice: Geist Mono, lowercase,
// 11.5px, tracking 0.04em. Authors write source text in any case
// ("Name", "DATABASE_URL") — the visual lowercase is a CSS transform,
// so screen readers still hear the canonical form. See DESIGN.md.
const Label = React.forwardRef<
  HTMLLabelElement,
  React.LabelHTMLAttributes<HTMLLabelElement>
>(({ className, ...props }, ref) => (
  <label
    ref={ref}
    className={cn(
      "font-mono text-[11.5px] font-medium leading-none tracking-[0.04em] lowercase text-foreground",
      "peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
      className,
    )}
    {...props}
  />
));
Label.displayName = "Label";

export { Label };
