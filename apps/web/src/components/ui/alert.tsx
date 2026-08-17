import * as React from "react";

import { cn } from "@/lib/utils";

// Inline message block in the semantic colors — the shape that was being
// hand-rolled as `border border-[hsl(var(--deny)/0.4)] bg-[hsl(var(--deny)/0.08)]
// px-3 py-2` in try-statement, masked-preview-panel, exposure-scan and the
// add-database banner. Rectangular per DESIGN.md; hairline border, tinted fill,
// no shadow.
//
// Use it — not an AlertDialog — for anything the user can act on in place:
// validation failures, a probe that didn't connect, a "saved" confirmation. A
// modal interrupts and has to be dismissed before the field it's complaining
// about can be fixed, which is why DESIGN.md reserves AlertDialog for
// destructive confirmations.
//
// `tone` is the query-lifecycle vocabulary (allow / deny / warn), not generic
// green/red/yellow. deny defaults to role="alert" so a screen reader announces
// a failure that appears after a click; allow/warn default to role="status".

const TONE_BOX = {
  allow: "border-[hsl(var(--allow)/0.4)] bg-[hsl(var(--allow)/0.08)]",
  deny: "border-[hsl(var(--deny)/0.4)] bg-[hsl(var(--deny)/0.08)]",
  warn: "border-[hsl(var(--warn)/0.4)] bg-[hsl(var(--warn)/0.08)]",
} as const;

const TONE_TEXT = {
  allow: "text-[hsl(var(--allow))]",
  deny: "text-[hsl(var(--deny))]",
  warn: "text-[hsl(var(--warn))]",
} as const;

export type AlertTone = keyof typeof TONE_BOX;

// `title` is ours, not the HTML tooltip attribute — the box IS the message, so
// there's nothing left to hover for.
export interface AlertProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  tone?: AlertTone;
  /** Short headline naming the kind of problem. Optional — a one-liner reads
   *  better with no title at all. */
  title?: React.ReactNode;
  /** The remedy, set below the body in the muted voice. */
  hint?: React.ReactNode;
}

const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className, tone = "deny", title, hint, children, ...props }, ref) => (
    <div
      ref={ref}
      role={tone === "deny" ? "alert" : "status"}
      className={cn("border px-3 py-2.5 text-xs", TONE_BOX[tone], className)}
      {...props}
    >
      {title ? (
        <p className={cn("font-medium", TONE_TEXT[tone])}>{title}</p>
      ) : null}
      {children ? (
        <div
          className={cn(
            "leading-relaxed",
            title ? "mt-0.5 text-foreground" : TONE_TEXT[tone],
          )}
        >
          {children}
        </div>
      ) : null}
      {hint ? (
        <p className="mt-1.5 leading-relaxed text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  ),
);
Alert.displayName = "Alert";

export { Alert };
