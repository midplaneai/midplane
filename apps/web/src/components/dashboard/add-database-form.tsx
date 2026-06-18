"use client";

import { useEffect, useState, useTransition } from "react";
import { Plus, X } from "lucide-react";

import { AccessRadio } from "@/components/access-radio";
import { TestDsnButton } from "@/components/projects/test-dsn-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Inline expansion form rendered under each project's DB list. Two
// surfaces in one component: the toggle button (when collapsed) and
// the form (when expanded). The collapsed shape replaces the disabled
// "soon" chip from PR-B.
//
// State model: form fields are uncontrolled inputs — we read values
// out via FormData in the submit handler. The pre-submit
// [Test project] button is the one place we have to peek into the
// inputs early, so we keep refs into the form for that probe.
//
// Submit flow: client-side validates the name regex (matches OSS
// DB_NAME_RE), then awaits the server action. Server-thrown errors
// (DatabaseNameTaken, DSN format) surface inline. On success the form
// resets, collapses, and the parent's revalidatePath('/dashboard') in
// the server action paints the new row.

const DB_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export function AddDatabaseForm({
  projectId,
  action,
  embedded = false,
  onClose,
}: {
  projectId: string;
  // Server action: receives FormData with `name`, `dsn`,
  // `default_access`. Throws on validation / collision so we can
  // catch + render inline.
  action: (formData: FormData) => Promise<void>;
  // Embedded: always-expanded form with no collapsed toggle and no own
  // header (the host — e.g. a Sheet — owns the chrome). onClose fires on a
  // successful add or cancel so the host can dismiss.
  embedded?: boolean;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Remount key for TestDsnButton — bumping it clears a stale
  // "✓ reachable" the moment any input changes.
  const [testVersion, setTestVersion] = useState(0);
  // Transient banner shown for ~4s after a successful add — the new
  // row paints from the revalidated server data; this banner just
  // reassures the user that the engine will pick the DB up on the next
  // agent call. Cleared by the unmount/effect when the timer expires.
  const [justAdded, setJustAdded] = useState<string | null>(null);
  useEffect(() => {
    if (!justAdded) return;
    const t = window.setTimeout(() => setJustAdded(null), 4000);
    return () => window.clearTimeout(t);
  }, [justAdded]);

  if (!embedded && !open) {
    return (
      <div className="border-t border-border px-3 py-2">
        {justAdded ? (
          <div
            className="mb-2 rounded-md border border-[hsl(var(--allow)/0.4)] bg-[hsl(var(--allow)/0.08)] px-2.5 py-1.5 text-xs text-[hsl(var(--allow))] motion-safe:animate-in motion-safe:fade-in"
            role="status"
          >
            <span className="font-mono">{justAdded}</span> added · agent can
            reach it on next call
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
          Add database to this project
        </button>
      </div>
    );
  }

  function reset() {
    setError(null);
    setTestVersion((v) => v + 1);
  }

  function dismiss() {
    reset();
    if (embedded) onClose?.();
    else setOpen(false);
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    reset();

    const form = event.currentTarget;
    const fd = new FormData(form);
    const name = (fd.get("name") ?? "").toString().trim();
    const dsn = (fd.get("dsn") ?? "").toString();
    if (!DB_NAME_RE.test(name)) {
      setError(
        "Name must be 1–32 lowercase letters / digits / _ - , starting with a letter.",
      );
      return;
    }
    if (!dsn.startsWith("postgres://") && !dsn.startsWith("postgresql://")) {
      setError("DSN must be a postgres:// or postgresql:// URL.");
      return;
    }

    fd.set("projectId", projectId);

    startTransition(async () => {
      try {
        await action(fd);
        // Server action revalidates the page; the new database paints on
        // the next render. Embedded (in a Sheet) we hand control back to the
        // host to dismiss; inline we collapse + flash a confirmation banner.
        form.reset();
        setError(null);
        setTestVersion((v) => v + 1);
        if (embedded) {
          onClose?.();
        } else {
          setOpen(false);
          setJustAdded(name);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "add failed");
      }
    });
  }

  return (
    <div
      className={embedded ? "" : "border-t border-border bg-muted/20 px-3 py-3"}
    >
      <form onSubmit={handleSubmit} className="space-y-3">
        {!embedded ? (
          <div className="flex items-baseline justify-between">
            <h3 className="font-mono text-[11.5px] font-medium lowercase tracking-[0.04em] text-subtle">
              Add database
            </h3>
            <button
              type="button"
              onClick={dismiss}
              className="text-subtle hover:text-foreground"
              aria-label="Close add-database form"
            >
              <X className="h-3.5 w-3.5" strokeWidth={1.5} />
            </button>
          </div>
        ) : null}

        <div
          className={`grid gap-3 ${embedded ? "" : "sm:grid-cols-[180px_1fr]"}`}
        >
          <div className="space-y-1.5">
            <Label htmlFor="add-db-name" className="text-xs">
              Name
            </Label>
            <Input
              id="add-db-name"
              name="name"
              type="text"
              required
              autoComplete="off"
              placeholder="analytics"
              pattern="^[a-z][a-z0-9_\-]{0,31}$"
              maxLength={32}
              className="font-mono"
              onChange={reset}
            />
            <p className="text-[11px] text-muted-foreground">
              Agent-facing alias.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="add-db-dsn" className="text-xs">
              DATABASE_URL
            </Label>
            <Input
              id="add-db-dsn"
              name="dsn"
              type="password"
              required
              autoComplete="new-password"
              data-1p-ignore
              data-lpignore="true"
              placeholder="postgres://user:pass@host:5432/db"
              className="font-mono"
              onChange={reset}
            />
          </div>
        </div>

        <fieldset className="space-y-1.5">
          <legend className="font-mono text-[11.5px] font-medium lowercase tracking-[0.04em] text-foreground">
            Default agent access
          </legend>
          <div className={`grid gap-2 ${embedded ? "" : "sm:grid-cols-3"}`}>
            <AccessRadio
              value="read"
              label="Read"
              description="Read any table; per-table writes still need explicit grants."
              defaultChecked
            />
            <AccessRadio
              value="deny"
              label="Deny"
              description="Allowlist mode. No access until you grant it."
            />
            <AccessRadio
              value="read_write"
              label="Read + write"
              description="Full access. Use sparingly."
            />
          </div>
        </fieldset>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <TestDsnButton
            key={testVersion}
            endpoint={`/api/projects/${projectId}/databases/test`}
            disabled={pending}
          />
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Adding…" : "Add database"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={dismiss}
          >
            Cancel
          </Button>
          {error ? (
            <span className="text-xs text-destructive">{error}</span>
          ) : null}
        </div>
      </form>
    </div>
  );
}


