"use client";

import { Loader2 } from "lucide-react";
import * as React from "react";
import { useFormStatus } from "react-dom";

import { Button, type ButtonProps } from "@/components/ui/button";

// Submit button that reads its own pending state off the enclosing <form>.
//
// Any button whose action goes to the server has to say it is working: a
// provisioning step (workspace setup, project create, pause/resume, delete)
// takes seconds, and a button that stays lit and clickable through that reads
// as "nothing happened" — the user clicks again. Spinners are one of the two
// motions DESIGN.md ships by default, so this is the sanctioned progress
// affordance.
//
// Drop it in place of `<Button type="submit">` anywhere the parent has a form
// action — including inside a server component, since useFormStatus lives in
// this client boundary. The parent needs no state of its own. It works with
// both `<form action={serverAction}>` and useActionState-driven forms (the
// hooks track the same in-flight action).
//
// Requirements: it must be rendered INSIDE the <form> it submits (useFormStatus
// reads the nearest form's status — a sibling of the form always reports idle).

export interface SubmitButtonProps extends ButtonProps {
  /** Label while the action is in flight. Defaults to the idle children. */
  pendingLabel?: React.ReactNode;
  /** Fires when pending flips back to false — the action settled (success or
   *  failure). Used by AlertDialog hosts to close the dialog only once the
   *  work is actually done, instead of the instant the button is clicked. */
  onSettled?: () => void;
}

export function SubmitButton({
  pendingLabel,
  onSettled,
  arrow,
  disabled,
  children,
  ...props
}: SubmitButtonProps) {
  const { pending } = useFormStatus();
  // Edge-triggered: only the true→false transition is a settle. Re-running on
  // an inline `onSettled` identity change is harmless — the flag is already
  // back in sync, so the guard is false.
  const wasPending = React.useRef(false);
  React.useEffect(() => {
    if (wasPending.current && !pending) onSettled?.();
    wasPending.current = pending;
  }, [pending, onSettled]);

  return (
    <Button
      type="submit"
      // Double-submit protection comes free with the progress indicator.
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      // The arrow is a "go" affordance; while in flight the spinner is the
      // one moving element, and keeping both makes the label jitter.
      arrow={arrow && !pending}
      {...props}
    >
      {pending ? (
        <>
          <Loader2
            aria-hidden
            className="mr-2 h-3.5 w-3.5 motion-safe:animate-spin"
            strokeWidth={1.5}
          />
          {pendingLabel ?? children}
        </>
      ) : (
        children
      )}
    </Button>
  );
}
