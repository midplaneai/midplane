"use client";

import { Loader2, Search, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import * as React from "react";

import { cn } from "@/lib/utils";

const DEBOUNCE_MS = 300;

// Search-as-you-type for the audit log. Writes the `q` param to the URL on a
// debounced keystroke (router.replace, so typing doesn't flood history) and
// drops the pagination cursor so results restart at the newest match. The
// input is uncontrolled — the client component stays mounted across the soft
// navigation, so focus and caret position survive each refetch. We only
// re-sync the field from the URL when the value changes externally (e.g. the
// "clear all" pill) and the field isn't focused, so an in-flight edit is never
// clobbered.
export function AuditSearch({
  initialValue,
  className,
}: {
  initialValue: string;
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [isPending, startTransition] = React.useTransition();
  const [hasValue, setHasValue] = React.useState(initialValue.length > 0);

  const commit = React.useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams);
      const trimmed = value.trim();
      if (trimmed) params.set("q", trimmed);
      else params.delete("q");
      params.delete("cursor"); // new query → jump back to the newest page
      const qs = params.toString();
      startTransition(() => {
        router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
      });
    },
    [router, pathname, searchParams],
  );

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value;
    setHasValue(value.length > 0);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => commit(value), DEBOUNCE_MS);
  }

  function flush() {
    clearTimeout(timer.current);
    commit(inputRef.current?.value ?? "");
  }

  function clear() {
    if (inputRef.current) inputRef.current.value = "";
    setHasValue(false);
    clearTimeout(timer.current);
    commit("");
    inputRef.current?.focus();
  }

  // Re-sync from the URL when `q` is changed by something other than this
  // input (clear-all, back/forward), but never while the user is mid-edit.
  React.useEffect(() => {
    const el = inputRef.current;
    if (el && document.activeElement !== el && el.value !== initialValue) {
      el.value = initialValue;
      setHasValue(initialValue.length > 0);
    }
  }, [initialValue]);

  React.useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <div className={cn("relative", className)}>
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle"
        aria-hidden
      />
      <input
        ref={inputRef}
        type="search"
        defaultValue={initialValue}
        onChange={onChange}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            flush();
          }
        }}
        placeholder="Search SQL, fingerprint or query_id…"
        aria-label="Search audit rows"
        // Hide the native WebKit clear button — we render our own.
        className={cn(
          "h-8 w-full rounded-none border border-border bg-secondary pl-8 pr-8 text-xs text-foreground",
          "placeholder:text-[hsl(var(--placeholder))]",
          "focus:border-[hsl(var(--brand))] focus:outline-none",
          "[&::-webkit-search-cancel-button]:appearance-none",
        )}
      />
      <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center">
        {isPending && (
          <Loader2
            className="h-3.5 w-3.5 animate-spin text-subtle motion-reduce:hidden"
            aria-hidden
          />
        )}
        {!isPending && hasValue && (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear search"
            className="text-subtle transition-colors hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}
