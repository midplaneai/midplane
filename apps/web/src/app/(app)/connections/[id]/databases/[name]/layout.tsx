import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Topbar } from "@/components/layout/app-shell";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { listDatabasesForConnection } from "@/lib/connections";
import { currentCustomer } from "@/lib/customer";
import { cn } from "@/lib/utils";

// Connection-context strip for every per-DB page. Mounted ONCE as a
// nested layout (eng review 1A) so it cannot drift across pages: the
// db page used to dead-end — no path to sibling databases or the
// connection's settings without backing out to the list.
//
//   ┌ topbar: connections : acme-prod : orders_prod ──────────────┐
//   ├ strip:  ← acme-prod │ orders_prod │ analytics │ … │ settings ┤
//   └ page:   (PageContainer from the child route)                 ┘
//
// The layout owns the Topbar too — the strip must sit BELOW the
// breadcrumb, and children render after the layout's own markup, so
// the page can no longer render its own Topbar.
//
// Overflow rule (design doc): past MAX_VISIBLE_DB_TABS databases the
// rest collapse into a native <details> dropdown — no client JS, and
// the strip doesn't quietly bet on low db counts. The current db is
// always visible even when it sorts past the cutoff.

const MAX_VISIBLE_DB_TABS = 4;

export default async function DatabaseContextLayout({
  params,
  children,
}: {
  params: Promise<{ id: string; name: string }>;
  children: React.ReactNode;
}) {
  const customer = await currentCustomer();
  if (!customer) redirect("/signup/region");

  const { id, name } = await params;
  const current = decodeURIComponent(name);
  const result = await listDatabasesForConnection(customer, id);
  if (!result) notFound();
  const { connection: conn, databases } = result;

  const connectionLabel = conn.name ?? conn.id.slice(0, 12);

  // Always keep the current db visible: take the first N; if the
  // current db sorts past the cutoff, swap it in for the last slot.
  const names = databases.map((d) => d.name);
  let visible = names.slice(0, MAX_VISIBLE_DB_TABS);
  if (names.includes(current) && !visible.includes(current)) {
    visible = [...visible.slice(0, MAX_VISIBLE_DB_TABS - 1), current];
  }
  const overflow = names.filter((n) => !visible.includes(n));

  return (
    <>
      <Topbar>
        <Breadcrumb
          items={[
            { label: "Connections", href: "/dashboard" },
            { label: connectionLabel, href: `/connections/${conn.id}` },
            { label: current },
          ]}
        />
      </Topbar>
      <nav
        aria-label="Connection context"
        className="flex items-center gap-1 overflow-x-auto border-b border-border bg-background px-6"
        data-testid="db-context-strip"
      >
        <Link
          href={`/connections/${conn.id}`}
          className="max-w-[200px] truncate whitespace-nowrap py-2 pr-3 font-mono text-xs lowercase tracking-[0.04em] text-subtle transition-colors hover:text-foreground"
        >
          ← {connectionLabel}
        </Link>
        {visible.map((dbName) => {
          const isCurrent = dbName === current;
          return (
            <Link
              key={dbName}
              href={`/connections/${conn.id}/databases/${encodeURIComponent(dbName)}`}
              aria-current={isCurrent ? "page" : undefined}
              className={cn(
                "whitespace-nowrap border-b-2 px-3 py-2 font-mono text-xs tracking-[0.04em] transition-colors",
                isCurrent
                  ? "border-[hsl(var(--brand))] text-foreground"
                  : "border-transparent text-subtle hover:text-foreground",
              )}
            >
              {dbName}
            </Link>
          );
        })}
        {overflow.length > 0 ? (
          <details className="relative">
            <summary className="cursor-pointer list-none whitespace-nowrap px-3 py-2 font-mono text-xs tracking-[0.04em] text-subtle transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
              +{overflow.length} more ▾
            </summary>
            <div className="absolute left-0 z-20 mt-1 min-w-[160px] border border-border bg-popover py-1">
              {overflow.map((dbName) => (
                <Link
                  key={dbName}
                  href={`/connections/${conn.id}/databases/${encodeURIComponent(dbName)}`}
                  className="block px-3 py-1.5 font-mono text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {dbName}
                </Link>
              ))}
            </div>
          </details>
        ) : null}
        <Link
          href={`/connections/${conn.id}/settings`}
          className="ml-auto whitespace-nowrap py-2 pl-3 font-mono text-xs lowercase tracking-[0.04em] text-subtle transition-colors hover:text-foreground"
        >
          settings
        </Link>
      </nav>
      {children}
    </>
  );
}
