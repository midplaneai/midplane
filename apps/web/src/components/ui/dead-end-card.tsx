// Centered dead-end notice for whole-page terminal states (error boundary,
// 404). Distinct from EmptyState (in-flow, list-shaped): this one owns the
// viewport and always offers a way onward via `actions` — the support audit
// found error states with no path to a human, and sharing the shell keeps the
// two boundaries from drifting apart. Pure presentational: usable from both
// server components (not-found) and client components (error boundary).
export function DeadEndCard({
  label,
  title,
  description,
  actions,
}: {
  /** Lowercase-mono eyebrow, e.g. "error" or "404". */
  label: string;
  title: string;
  description: React.ReactNode;
  actions: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[70vh] items-center justify-center p-6">
      <div className="w-full max-w-[480px] border border-dashed border-border p-10 text-center">
        <p className="font-mono text-[11.5px] font-medium lowercase tracking-[0.04em] text-subtle">
          {label}
        </p>
        <h1 className="mt-2 text-lg font-semibold text-foreground">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          {actions}
        </div>
      </div>
    </div>
  );
}
