import Link from "next/link";
import { redirect } from "next/navigation";

import { EventBadge } from "@/components/audit/event-badge";
import { relativeTime } from "@/components/audit/relative-time";
import { StalenessBanner } from "@/components/audit/staleness-banner";
import { Topbar, PageContainer } from "@/components/layout/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";
import {
  getAuditEvent,
  getRelatedEvents,
  readStaleness,
} from "@/lib/audit";
import { currentCustomer } from "@/lib/customer";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function AuditDetailPage({ params }: PageProps) {
  const customer = await currentCustomer();
  if (!customer) redirect("/signup/region");

  const { id } = await params;
  const event = await getAuditEvent(customer.id, id);
  const staleness = await readStaleness(customer.id, customer.region);

  if (!event) {
    return (
      <>
        <Topbar>
          <Link href="/audit">
            <b className="font-medium text-foreground">Audit log</b>
          </Link>
          <span className="mx-2 text-subtle">/</span>Not found
        </Topbar>
        <PageContainer>
          <StalenessBanner read={staleness} />
          <EmptyState
            data-testid="audit-detail-missing"
            title="Audit row not found."
            description={
              <>
                This audit row no longer exists or is outside your retention
                window.
                <div className="mt-4">
                  <Link
                    href="/audit"
                    className="text-[hsl(var(--brand))] underline underline-offset-2"
                  >
                    ← Back to audit log
                  </Link>
                </div>
              </>
            }
          />
        </PageContainer>
      </>
    );
  }

  const related = await getRelatedEvents(customer.id, event.queryId);
  const payloadJson = JSON.stringify(event.payload, null, 2);

  return (
    <>
      <Topbar>
        <Link href="/audit">
          <b className="font-medium text-foreground">Audit log</b>
        </Link>
        <span className="mx-2 text-muted-foreground">/</span>
        <span className="font-mono">{truncate(event.id, 16)}</span>
      </Topbar>
      <PageContainer>
        <PageHeader
          title={
            <span className="inline-flex items-center gap-2">
              <EventBadge eventType={event.eventType} />
              <span>Audit event</span>
            </span>
          }
          subtitle={
            <span className="inline-flex items-center gap-1.5">
              <span className="font-mono">{event.id}</span> ·{" "}
              {relativeTime(event.ts)}
            </span>
          }
        />
        <StalenessBanner read={staleness} />

        <div className="mt-[18px] grid gap-6 md:grid-cols-[280px_1fr]">
          <Card>
            <CardHeader>
              <CardTitle>Metadata</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[110px_1fr] gap-y-1.5 gap-x-3 text-xs">
                <Dt>Time</Dt>
                <Dd>{event.ts.toISOString()}</Dd>
                <Dt>Event</Dt>
                <Dd>{event.eventType}</Dd>
                <Dt>Tenant</Dt>
                <Dd>{event.tenantId}</Dd>
                <Dt>Agent</Dt>
                <Dd>{event.agentIdentity ?? "—"}</Dd>
                <Dt>Query ID</Dt>
                <Dd>{event.queryId}</Dd>
                <Dt>Region</Dt>
                <Dd>{event.region}</Dd>
                <Dt>Schema</Dt>
                <Dd>v{event.schemaVersion}</Dd>
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Payload</CardTitle>
            </CardHeader>
            <CardContent>
              <pre
                data-testid="audit-payload"
                className="overflow-x-auto whitespace-pre rounded-md border border-border bg-popover p-3.5 font-mono text-xs leading-relaxed text-foreground"
              >
                {payloadJson}
              </pre>
            </CardContent>
          </Card>
        </div>

        <section className="mt-6">
          <h2 className="mb-3 text-[11px] font-medium uppercase tracking-[0.04em] text-subtle">
            Lifecycle ({related.length} event{related.length === 1 ? "" : "s"}{" "}
            for this query)
          </h2>
          <div data-testid="audit-related" className="space-y-px">
            {related.map((r) => (
              <Link
                key={r.id}
                href={`/audit/${r.id}`}
                className={cn(
                  "grid grid-cols-[80px_100px_1fr_80px] items-center gap-3 border-b border-card px-3 py-2.5 text-xs",
                  r.id === event.id && "bg-card",
                )}
              >
                <span className="whitespace-nowrap font-mono text-[11px] text-subtle">
                  {r.ts.toISOString().slice(11, 23)}
                </span>
                <EventBadge eventType={r.eventType} />
                <span className="block max-w-[340px] truncate font-mono text-xs text-foreground">
                  {payloadFingerprint(r.payload)}
                </span>
                <span className="font-mono text-[11px] text-subtle">
                  {r.id === event.id ? "current" : ""}
                </span>
              </Link>
            ))}
          </div>
        </section>
      </PageContainer>
    </>
  );
}

function Dt({ children }: { children: React.ReactNode }) {
  return (
    <dt className="text-[11px] uppercase tracking-[0.04em] text-subtle">
      {children}
    </dt>
  );
}

function Dd({ children }: { children: React.ReactNode }) {
  return (
    <dd className="break-all font-mono text-xs text-foreground">{children}</dd>
  );
}

function payloadFingerprint(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "—";
  const p = payload as Record<string, unknown>;
  const fp = p.sql_fingerprint;
  if (typeof fp === "string") return fp;
  const decision = p.decision;
  if (typeof decision === "string") return `decision=${decision}`;
  const reason = p.reason;
  if (typeof reason === "string") return reason;
  return Object.keys(p).slice(0, 3).join(", ") || "—";
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
