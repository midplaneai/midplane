import Link from "next/link";
import { redirect } from "next/navigation";

import { EventBadge } from "@/components/audit/event-badge";
import { relativeTime } from "@/components/audit/relative-time";
import { StalenessBanner } from "@/components/audit/staleness-banner";
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
        <header className="md-topbar">
          <div className="md-breadcrumb">
            <Link href="/audit">
              <b>Audit log</b>
            </Link>
            <span className="md-breadcrumb-sep">/</span>Not found
          </div>
        </header>
        <div className="md-content">
          <StalenessBanner read={staleness} />
          <div className="md-empty" data-testid="audit-detail-missing">
            <div className="md-empty-title">Audit row not found.</div>
            <div>
              This audit row no longer exists or is outside your retention
              window.
            </div>
            <div style={{ marginTop: 16 }}>
              <Link
                href="/audit"
                style={{ color: "var(--accent)", textDecoration: "underline" }}
              >
                ← Back to audit log
              </Link>
            </div>
          </div>
        </div>
      </>
    );
  }

  const related = await getRelatedEvents(customer.id, event.queryId);
  const payloadJson = JSON.stringify(event.payload, null, 2);

  return (
    <>
      <header className="md-topbar">
        <div className="md-breadcrumb">
          <Link href="/audit">
            <b>Audit log</b>
          </Link>
          <span className="md-breadcrumb-sep">/</span>
          <span className="mono">{truncate(event.id, 16)}</span>
        </div>
      </header>
      <div className="md-content">
        <div className="md-page-header">
          <h1 className="md-page-title">
            <EventBadge eventType={event.eventType} />{" "}
            <span style={{ marginLeft: 8 }}>Audit event</span>
          </h1>
        </div>
        <div className="md-subtitle">
          <span className="mono">{event.id}</span> · {relativeTime(event.ts)}
        </div>
        <StalenessBanner read={staleness} />

        <div className="md-detail-grid">
          <aside className="md-card">
            <div className="md-card-title">Metadata</div>
            <dl className="md-kv">
              <dt>Time</dt>
              <dd>{event.ts.toISOString()}</dd>
              <dt>Event</dt>
              <dd>{event.eventType}</dd>
              <dt>Tenant</dt>
              <dd>{event.tenantId}</dd>
              <dt>Agent</dt>
              <dd>{event.agentIdentity ?? "—"}</dd>
              <dt>Query ID</dt>
              <dd>{event.queryId}</dd>
              <dt>Region</dt>
              <dd>{event.region}</dd>
              <dt>Schema</dt>
              <dd>v{event.schemaVersion}</dd>
            </dl>
          </aside>
          <section>
            <div className="md-card">
              <div className="md-card-title">Payload</div>
              <pre className="md-payload" data-testid="audit-payload">
                {payloadJson}
              </pre>
            </div>
          </section>
        </div>

        <section className="md-related">
          <div className="md-card-title">
            Lifecycle ({related.length} event{related.length === 1 ? "" : "s"}{" "}
            for this query)
          </div>
          <div data-testid="audit-related">
            {related.map((r) => (
              <Link
                key={r.id}
                href={`/audit/${r.id}`}
                className={`md-related-row${r.id === event.id ? " current" : ""}`}
              >
                <span className="md-ts">{r.ts.toISOString().slice(11, 23)}</span>
                <EventBadge eventType={r.eventType} />
                <span className="md-fingerprint">
                  {payloadFingerprint(r.payload)}
                </span>
                <span className="md-muted mono">
                  {r.id === event.id ? "current" : ""}
                </span>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </>
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
