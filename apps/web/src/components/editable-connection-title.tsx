"use client";

import { useEffect, useRef, useState, useTransition } from "react";

import { MAX_CONNECTION_NAME_LENGTH } from "@/lib/connection-name";

// Inline-editable connection title. Click the title to edit; Enter or blur
// saves; Escape cancels. Empty value clears the name and falls back to the
// placeholder. Pure cosmetic field — no caches/containers to invalidate, so
// failures are surfaced inline without blowing up the page.

export function EditableConnectionTitle({
  id,
  initialName,
  placeholder,
  action,
}: {
  id: string;
  initialName: string | null;
  placeholder: string;
  action: (formData: FormData) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState(initialName ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset local value if the server-rendered name changes underneath us
  // (e.g. another tab renamed the row).
  useEffect(() => {
    if (!editing) setValue(initialName ?? "");
  }, [initialName, editing]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function commit() {
    const next = value.trim();
    const current = initialName ?? "";
    if (next === current) {
      setEditing(false);
      setError(null);
      return;
    }
    const fd = new FormData();
    fd.set("id", id);
    fd.set("name", next);
    setError(null);
    startTransition(async () => {
      try {
        await action(fd);
        setEditing(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : "rename failed");
      }
    });
  }

  function cancel() {
    setValue(initialName ?? "");
    setError(null);
    setEditing(false);
  }

  if (!editing) {
    return (
      <div className="space-y-1">
        <h1
          role="button"
          tabIndex={0}
          onClick={() => setEditing(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setEditing(true);
            }
          }}
          className="-mx-2 cursor-text rounded px-2 py-1 text-2xl font-semibold tracking-tight hover:bg-muted/60 focus:bg-muted/60 focus:outline-none"
          title="Click to rename"
        >
          {initialName ?? (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
        </h1>
        {error ? (
          <p className="px-2 text-sm text-destructive">{error}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <input
        ref={inputRef}
        type="text"
        value={value}
        disabled={pending}
        maxLength={MAX_CONNECTION_NAME_LENGTH}
        placeholder={placeholder}
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
        className="-mx-2 w-full rounded border border-input bg-background px-2 py-1 text-2xl font-semibold tracking-tight focus:outline-none focus:ring-2 focus:ring-ring"
      />
      <p className="px-2 text-xs text-muted-foreground">
        {pending ? "Saving…" : "Enter to save · Esc to cancel"}
      </p>
      {error ? (
        <p className="px-2 text-sm text-destructive">{error}</p>
      ) : null}
    </div>
  );
}
