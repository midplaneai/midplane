import Link from "next/link";

import { cn } from "@/lib/utils";

// Breadcrumb — lowercase mono with a blue colon separator. The colon is the
// brand mark applied to navigation, mirroring `mid:plane`. Source text can be
// any case ("Connections", "DATABASE_URL"); CSS lowercases visually while the
// DOM keeps the canonical form for screen readers. The colon is aria-hidden
// so SR users hear segments via the implicit list semantics.
//
//   <Breadcrumb items={[{ label: "Connections", href: "/dashboard" }, { label: "New" }]} />

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export function Breadcrumb({
  items,
  className,
}: {
  items: BreadcrumbItem[];
  className?: string;
}) {
  return (
    <nav
      aria-label="Breadcrumb"
      className={cn(
        "font-mono text-[12px] lowercase tracking-[0.02em] text-subtle",
        className,
      )}
    >
      <ol className="flex items-center gap-1.5">
        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          return (
            <li key={`${item.label}-${i}`} className="flex items-center gap-1.5">
              {item.href && !isLast ? (
                <Link
                  href={item.href}
                  className="transition-colors hover:text-foreground"
                >
                  {item.label}
                </Link>
              ) : (
                <span
                  className="text-foreground"
                  aria-current={isLast ? "page" : undefined}
                >
                  {item.label}
                </span>
              )}
              {!isLast && (
                <span
                  aria-hidden
                  className="font-bold text-[hsl(var(--brand))]"
                >
                  :
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
