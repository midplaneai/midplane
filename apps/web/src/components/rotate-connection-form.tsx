"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Inline rotate form rendered on /connections/[id]. The Server Action passed
// in via `action` re-encrypts and atomically swaps the ciphertext + invalidates
// the in-memory caches; this component just collects the new DSN and shows a
// pending state during the round-trip.
//
// We keep error rendering simple (a small banner). Server Actions surface
// thrown errors via the framework's error boundary, but the rotateConnection
// path explicitly does NOT throw on cache invalidation failure (the DB write
// is durable; caches catch up on idle), so a thrown error here means a real
// problem worth showing.

export function RotateConnectionForm({
  id,
  action,
}: {
  id: string;
  action: (formData: FormData) => Promise<void>;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      action={(formData) => {
        setError(null);
        startTransition(async () => {
          try {
            await action(formData);
          } catch (e) {
            setError(e instanceof Error ? e.message : "rotation failed");
          }
        });
      }}
      className="space-y-3"
    >
      <input type="hidden" name="id" value={id} />
      <Input
        type="password"
        name="dsn"
        required
        autoComplete="new-password"
        data-1p-ignore
        data-lpignore="true"
        placeholder="postgres://user:pass@host:5432/db"
        className="font-mono"
      />
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Rotating…" : "Rotate DSN"}
        </Button>
        {error ? (
          <span className="text-sm text-destructive">{error}</span>
        ) : null}
      </div>
    </form>
  );
}
