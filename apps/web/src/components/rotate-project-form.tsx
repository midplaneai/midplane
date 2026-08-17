"use client";

import { useState, useTransition } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { describeDsnProblem, normalizeDsn } from "@/lib/dsn-format";

// Inline rotate form rendered on the per-DB detail page. The Server Action
// passed in via `action` closes over the URL's project id + db name,
// re-encrypts, and atomically swaps the ciphertext + invalidates the
// in-memory caches; this component just collects the new DSN and shows a
// pending state during the round-trip.
//
// We keep error rendering simple (a small banner). Server Actions surface
// thrown errors via the framework's error boundary, but the rotateProject
// path explicitly does NOT throw on cache invalidation failure (the DB write
// is durable; caches catch up on idle), so a thrown error here means a real
// problem worth showing.
//
// Controlled input. `dirty` = the user has typed at least one non-blank
// character — Save disables on empty and Cancel clears the field. On
// success we also wipe the DSN so it doesn't linger in the input after
// the rotation has committed.

export function RotateProjectForm({
  id,
  action,
  onSuccess,
}: {
  id: string;
  action: (formData: FormData) => Promise<void>;
  /** Fires after a committed rotation so a host (e.g. a Sheet) can close. */
  onSuccess?: () => void;
}) {
  const [dsn, setDsn] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<{
    message: string;
    hint?: string;
  } | null>(null);

  const dirty = dsn.trim().length > 0;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const normalized = normalizeDsn(dsn);
    // Answer a bad paste here rather than after a round trip that ends in the
    // error boundary — same checker the action re-runs.
    const problem = describeDsnProblem(normalized);
    if (problem) {
      setError(problem);
      return;
    }

    const fd = new FormData();
    fd.set("id", id);
    fd.set("dsn", normalized);

    startTransition(async () => {
      try {
        await action(fd);
        // DSN is sensitive — clear after success so it doesn't sit in
        // the input. Also flips Save back to disabled.
        setDsn("");
        onSuccess?.();
      } catch (e) {
        setError({
          message:
            e instanceof Error
              ? e.message
              : "The connection string wasn't rotated.",
        });
      }
    });
  }

  function handleCancel() {
    setDsn("");
    setError(null);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="rotate-dsn">New connection string</Label>
        <Input
          id="rotate-dsn"
          type="text"
          name="dsn"
          value={dsn}
          onChange={(e) => {
            setDsn(e.target.value);
            setError(null);
          }}
          required
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          placeholder="postgres://user:pass@host:5432/db"
          className="font-mono"
          aria-invalid={error ? true : undefined}
          onBlur={() => {
            const trimmed = normalizeDsn(dsn);
            if (trimmed !== dsn) setDsn(trimmed);
            if (trimmed) setError(describeDsnProblem(trimmed));
          }}
        />
        {error ? (
          <Alert tone="deny" hint={error.hint}>
            {error.message}
          </Alert>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending || !dirty}>
          {pending ? "Rotating…" : "Rotate connection string"}
        </Button>
        {dirty && !pending && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleCancel}
            data-testid="rotate-cancel"
          >
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
