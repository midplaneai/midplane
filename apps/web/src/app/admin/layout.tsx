import Link from "next/link";

// Internal-operator chrome. Deliberately NOT the customer AppShell: the admin
// surface has no org/plan context (staff aren't org members), and it should
// read unmistakably as an internal tool — a slim bar, the two-dot mark, and an
// "internal" tag — so no one confuses aggregate staff data with a customer view.
//
// Layouts wrap PAGES only; the sibling route handler
// (/admin/customer/[id]/region) is unaffected by this file.
export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background">
      <header className="flex h-12 items-center gap-3 border-b border-border bg-card px-6">
        <Link href="/admin" className="flex items-center gap-2.5">
          <span aria-hidden className="inline-flex items-center gap-[3px]">
            <span className="block h-[5px] w-[5px] rounded-full bg-[hsl(var(--brand))]" />
            <span className="block h-[5px] w-[5px] rounded-full bg-[hsl(var(--brand))]" />
          </span>
          <span className="text-sm font-semibold tracking-tight text-foreground">
            Midplane
          </span>
        </Link>
        <span className="rounded-[3px] border border-[hsl(var(--warn)/0.2)] bg-[hsl(var(--warn)/0.08)] px-1.5 py-[2px] font-mono text-[10px] font-medium uppercase tracking-[0.04em] text-[hsl(var(--warn))]">
          Internal · Admin
        </span>
        <Link
          href="/dashboard"
          className="ml-auto font-mono text-[11px] lowercase tracking-[0.04em] text-subtle transition-colors hover:text-foreground"
        >
          ← back to app
        </Link>
      </header>
      <main className="mx-auto max-w-[1100px] px-6 py-8">{children}</main>
    </div>
  );
}
