"use client";

import { useEffect, useRef, useState, useTransition } from "react";

import { MAX_PROJECT_NAME_LENGTH } from "@/lib/project-name";
import { cn } from "@/lib/utils";

// Compact inline-editable project name for the dashboard row. Click the
// label to edit; Enter or blur saves; Esc cancels. Empty value clears the
// name and falls back to the placeholder.

export function RenameProjectInline({
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
      <button
        type="button"
        onClick={(e) => {
          // Prevent the parent row link / clickable area from intercepting.
          e.stopPropagation();
          setEditing(true);
        }}
        className={cn(
          "max-w-full truncate rounded-sm px-1 -mx-1 text-left text-sm font-medium tracking-tight transition-colors",
          "hover:bg-muted/60 focus:bg-muted/60 focus:outline-none",
          initialName ? "text-foreground" : "text-muted-foreground",
        )}
        title="Click to rename"
      >
        {initialName ?? placeholder}
        {error ? (
          <span className="ml-2 text-xs text-destructive">{error}</span>
        ) : null}
      </button>
    );
  }

  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      disabled={pending}
      maxLength={MAX_PROJECT_NAME_LENGTH}
      placeholder={placeholder}
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
      className="w-full max-w-[420px] rounded-sm border border-input bg-background px-1 -mx-1 text-sm font-medium tracking-tight focus:outline-none focus:ring-2 focus:ring-ring"
    />
  );
}
