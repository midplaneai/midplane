"use client";

import { useEffect, useRef, useState, useTransition } from "react";

import { cn } from "@/lib/utils";

// Inline-editable DB alias rendered inside the dashboard's DB row.
// Mirrors RenameConnectionInline's UX (click to edit, Enter saves, Esc
// cancels) but enforces the OSS DB_NAME_RE on the client and surfaces
// the per-DB restart trade-off in copy: renaming forces a container
// restart since the OSS engine treats `database` as an agent-facing
// identifier on every tool call.
//
// Submit posts a FormData with `connectionId`, `name` (oldName), and
// `newName`. The server action wraps the renameDatabase lib helper;
// DatabaseNameTaken from the helper surfaces here as the error string.

const DB_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export function RenameDatabaseInline({
  connectionId,
  initialName,
  action,
  onDone,
}: {
  connectionId: string;
  initialName: string;
  action: (formData: FormData) => Promise<void>;
  // Called when the rename completes (success or cancel) so the parent
  // can flip out of rename mode.
  onDone: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  function commit() {
    const next = value.trim();
    if (next === initialName) {
      setError(null);
      onDone();
      return;
    }
    if (!DB_NAME_RE.test(next)) {
      setError("1–32 lowercase letters / digits / _ - , starting with a letter.");
      return;
    }
    const fd = new FormData();
    fd.set("connectionId", connectionId);
    fd.set("name", initialName);
    fd.set("newName", next);
    setError(null);
    startTransition(async () => {
      try {
        await action(fd);
        onDone();
      } catch (e) {
        setError(e instanceof Error ? e.message : "rename failed");
      }
    });
  }

  function cancel() {
    setError(null);
    onDone();
  }

  return (
    <div className="flex flex-1 items-center gap-2 px-3 py-2.5">
      <input
        ref={inputRef}
        type="text"
        value={value}
        disabled={pending}
        maxLength={32}
        pattern="^[a-z][a-z0-9_\-]{0,31}$"
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        className={cn(
          "w-[200px] rounded-sm border border-input bg-background px-1.5 py-0.5 font-mono text-sm",
          "focus:outline-none focus:ring-2 focus:ring-ring",
        )}
      />
      <span className="text-[11px] text-muted-foreground">
        Renaming restarts the running session.
      </span>
      {error ? (
        <span className="text-xs text-destructive">{error}</span>
      ) : null}
    </div>
  );
}
