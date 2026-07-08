import { assertManager, isManager } from "@/lib/org-auth";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import {
  parseColumnMasksOrThrow,
  parseGuardrailsOrThrow,
  parseIgnoredColumnsOrThrow,
  parsePolicyOrThrow,
  type MaskColumnTypes,
} from "@midplane-cloud/db";
import { mcpGenericUrl } from "@midplane-cloud/router";
import { fetchColumnTypes } from "@/lib/scan-pii-columns";

import { ProjectRail } from "@/components/projects/project-rail";
import { OAuthConnectGuide } from "@/components/projects/oauth-connect-guide";
import {
  PROJECT_SECTIONS,
  type ProjectSection,
} from "@/components/projects/project-sections";
import { DatabaseStrip } from "@/components/projects/database-strip";
import { DeleteDatabaseButton } from "@/components/projects/delete-database-button";
import { ExposureScan } from "@/components/projects/exposure-scan";
import { MaskedPreviewPanel } from "@/components/projects/masked-preview-panel";
import { TestPolicyPanel } from "@/components/projects/test-policy-panel";
import { TestReachabilityButton } from "@/components/projects/test-reachability-button";
import { ServingStatus } from "@/components/dashboard/serving-status";
import { RenameProjectInline } from "@/components/dashboard/rename-project-inline";
import { DeleteProjectButton } from "@/components/delete-project-button";
import { PauseProjectButton } from "@/components/projects/pause-project-button";
import { GuardrailsToggles } from "@/components/guardrails-toggles";
import { Topbar, PageContainer } from "@/components/layout/app-shell";
import { PermissionGrid } from "@/components/permission-grid";
import { RenameDatabaseControl } from "@/components/projects/rename-database-control";
import { RotateCredentialSheet } from "@/components/projects/rotate-credential-sheet";
import { AgentList } from "@/components/tokens/agent-list";
import { Badge } from "@/components/ui/badge";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DatabaseNameTaken,
  deleteProject,
  emitConfigAuditRow,
  getProjectHomeData,
  getProjectWithDatabase,
  getProjectWithDatabaseAndCredential,
  getPlanUsage,
  maskConfigAddsMasking,
  isValidDatabaseName,
  isValidDsn,
  LastDatabaseProtected,
  pauseProject,
  removeDatabase,
  renameProject,
  renameDatabase,
  resumeProject,
  rotateProject,
  setColumnMasks,
  setGuardrails,
  setIgnoredColumns,
  setTableAccess,
} from "@/lib/projects";
import { currentCustomer } from "@/lib/customer";
import { addDatabaseFromForm } from "@/lib/database-form";
import { projectLabel, formatRelative } from "@/lib/format";
import { getMcpProxyContext } from "@/lib/mcp-proxy";
import { pingDsnGuarded } from "@/lib/ping-guard";
import { resolvePlan, UPGRADE_URL } from "@/lib/plan";
import { getPostHog } from "@/lib/posthog";
import {
  checkRateLimit,
  PING_TEST_RATE_LIMIT,
  pingTestKey,
} from "@/lib/rate-limit";
import { REGION_LABELS } from "@/lib/region";
import { listProjectAgents } from "@/lib/tokens";

import { createTokenAction, revokeTokenAction } from "./token-actions";

// Project workspace — one project, one persistent left rail. Every
// surface (project-wide + per-database) is a peer in the rail, so any of
// them is one click from any other; there's no "inside a database" sub-room
// and no ambiguous up-link, because the project name is the rail header,
// not a destination.
//
// The rail is organized by ASPECT, not by database. Multi-DB is a quiet
// switcher in the rail header (?db=) that retargets only the per-DB panes
// (Access, Source, per-DB reachability) — it disappears at one database.
//
// Per-DB server actions close over the selected db name (from ?db, the
// authoritative resource ref); a tampered ?db can only hit another db the
// caller already owns, which the lib re-checks under the hood.

const SECTION_VALUES = PROJECT_SECTIONS.map((s) => s.value);

const CARD = "rounded-lg border border-border bg-card p-6";

export default async function ProjectWorkspace({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ section?: string; db?: string; created?: string }>;
}) {
  const customer = await currentCustomer();
  if (!customer) redirect("/signup");

  // Owner/admin manage the project (policy, guardrails, tokens, DSN, databases,
  // delete); a member can view it and connect their agent (OAuth) but sees no
  // management controls. Each mutating action below also re-checks server-side.
  const canManage = await isManager();

  const { id } = await params;
  const { section, db, created } = await searchParams;
  // Set by the create flow's redirect (?created=1) so the Connect pane can flash
  // a one-time "project created" banner. Purely cosmetic.
  const justCreated = created === "1";
  const initialSection: ProjectSection = SECTION_VALUES.includes(
    section as ProjectSection,
  )
    ? (section as ProjectSection)
    : // A member's useful landing is their connect URL, not the (hidden)
      // table-permissions editor — default them to the Connect pane.
      canManage
      ? "database"
      : "connect";

  const { plan, caps } = await resolvePlan();
  const [home, agents, usage] = await Promise.all([
    getProjectHomeData(customer, id, caps.auditRetentionDays),
    listProjectAgents(customer, id),
    getPlanUsage(customer),
  ]);
  if (!home) notFound();
  const { project: conn, databases, cursor } = home;
  if (agents === null) notFound();

  const label = projectLabel(conn);

  // D2 (plan-design-review): an empty project (no databases yet — the
  // auto-seeded Default a new customer just landed on, or a project whose
  // databases were all removed) shows a focused setup hero instead of empty
  // data/token panes. The CTA routes to the paste-DSN flow, which reuses THIS
  // empty project (createProject) and mints the default token on the first
  // database — never the tokenless addDatabaseFromForm path.
  if (databases.length === 0) {
    return (
      <>
        <Topbar>
          <Breadcrumb
            items={[{ label: "Projects", href: "/dashboard" }, { label }]}
          />
        </Topbar>
        <PageContainer>
          <EmptyState
            title="Add your first database"
            description="Paste a Postgres connection string to connect your agent to your data. We encrypt it at rest and mint your agent's access token."
            action={
              <Link href="/projects/new">
                <Button size="sm">Add a database</Button>
              </Link>
            }
          />
        </PageContainer>
      </>
    );
  }

  // `paused` gates the Resume affordance in the rail header. The serving
  // status headline, the demoted audit-log line, and a manual "Test
  // connection" (wake) all live in the <ServingStatus> popover below.
  const paused = conn.pausedAt != null;
  const dbNames = databases.map((d) => d.name);

  // Which database the per-DB panes target. Trust ?db only if it names a db
  // on this project; otherwise fall back to the first.
  const selectedName =
    typeof db === "string" && dbNames.includes(db)
      ? db
      : (dbNames[0] ?? null);
  const selResult = selectedName
    ? await getProjectWithDatabase(customer, id, selectedName)
    : null;
  const selDb = selResult?.database ?? null;

  const tokenLimit =
    Number.isFinite(caps.tokens) && usage.tokens >= caps.tokens
      ? { limit: caps.tokens, plan, upgradeUrl: UPGRADE_URL }
      : undefined;

  // The region-wide OAuth MCP endpoint — /mcp (no id, no token). Non-secret
  // (auth is the OAuth sign-in), shown openly with a copy button. One URL per
  // account; the user chooses which project + databases the agent gets at the
  // consent screen (which forces an explicit project choice for multi-project
  // users — see consent-form.tsx — so it can't silently bind to the wrong one).
  // Computed server-side so it uses this deployment's real MCP host.
  const mcpUrl = mcpGenericUrl(conn.region, process.env);

  // ---- server actions ----------------------------------------------------

  async function renameAction(formData: FormData) {
    "use server";
    const customer = await currentCustomer();
    if (!customer) redirect("/");
    // Owner/admin only — controls are hidden from members, so a throw here is
    // the tamper-path backstop (defense in depth).
    await assertManager();
    const formId = formData.get("id");
    if (typeof formId !== "string" || formId.length === 0) {
      throw new Error("missing id");
    }
    const nameRaw = formData.get("name");
    const name = typeof nameRaw === "string" ? nameRaw : null;
    const renamed = await renameProject(customer, formId, name);
    if (!renamed) notFound();
    revalidatePath("/dashboard");
    revalidatePath(`/projects/${formId}`);
  }

  async function deleteAction(formData: FormData) {
    "use server";
    const customer = await currentCustomer();
    if (!customer) redirect("/");
    const { userId } = await assertManager();
    const formId = formData.get("id");
    if (typeof formId !== "string" || formId.length === 0) {
      throw new Error("missing id");
    }
    const deleted = await deleteProject(customer, formId);
    if (deleted) {
      const ctx = getMcpProxyContext();
      await ctx.registry.invalidate(deleted.id).catch((err) => {
        console.error(
          "[projects/[id].deleteAction] registry.invalidate failed",
          err,
        );
      });
      if (userId) {
        getPostHog()?.capture({
          distinctId: userId,
          event: "project_deleted",
          properties: {
            project_id: deleted.id,
            region: customer.region,
            source: "project_workspace",
          },
        });
      }
    }
    redirect("/dashboard");
  }

  async function pauseAction(formData: FormData) {
    "use server";
    const customer = await currentCustomer();
    if (!customer) redirect("/");
    const { userId } = await assertManager();
    const formId = formData.get("id");
    if (typeof formId !== "string" || formId.length === 0) {
      throw new Error("missing id");
    }
    const result = await pauseProject(customer, formId);
    if (!result) notFound();
    // Drop the running session so no agent request reaches the engine after
    // the switch flips — same teardown delete/rotate use. Best-effort: the
    // pause is already durable in Postgres and the resolver rejects every
    // request regardless; a failed teardown only lets the sidecar linger
    // until its idle timer.
    const ctx = getMcpProxyContext();
    await ctx.registry.invalidate(result.id).catch((err) => {
      console.error(
        "[projects/[id].pauseAction] registry.invalidate failed",
        err,
      );
    });
    if (userId) {
      try {
        await emitConfigAuditRow(customer, {
          tenantId: result.id,
          database: "main",
          eventType: "PROJECT_PAUSED",
          payload: { project_id: result.id, action: "paused" },
          actorUserId: userId,
        });
      } catch (err) {
        console.error(
          "[pauseAction] PROJECT_PAUSED audit write failed",
          err,
        );
      }
      getPostHog()?.capture({
        distinctId: userId,
        event: "project_paused",
        properties: {
          project_id: result.id,
          region: customer.region,
          source: "project_workspace",
        },
      });
    }
    revalidatePath("/dashboard");
    revalidatePath(`/projects/${result.id}`);
  }

  async function resumeAction(formData: FormData) {
    "use server";
    const customer = await currentCustomer();
    if (!customer) redirect("/");
    const { userId } = await assertManager();
    const formId = formData.get("id");
    if (typeof formId !== "string" || formId.length === 0) {
      throw new Error("missing id");
    }
    const result = await resumeProject(customer, formId);
    if (!result) notFound();
    // No teardown — the next agent request spawns a fresh engine with the
    // current policy. Clearing paused_at is all resume needs.
    if (userId) {
      try {
        await emitConfigAuditRow(customer, {
          tenantId: result.id,
          database: "main",
          eventType: "PROJECT_RESUMED",
          payload: { project_id: result.id, action: "resumed" },
          actorUserId: userId,
        });
      } catch (err) {
        console.error(
          "[resumeAction] PROJECT_RESUMED audit write failed",
          err,
        );
      }
      getPostHog()?.capture({
        distinctId: userId,
        event: "project_resumed",
        properties: {
          project_id: result.id,
          region: customer.region,
          source: "project_workspace",
        },
      });
    }
    revalidatePath("/dashboard");
    revalidatePath(`/projects/${result.id}`);
  }

  async function addDatabaseAction(formData: FormData) {
    "use server";
    const customer = await currentCustomer();
    if (!customer) redirect("/");
    await assertManager();
    const { projectId } = await addDatabaseFromForm(customer, formData);
    revalidatePath(`/projects/${projectId}`);
    revalidatePath("/dashboard");
  }

  // Per-DB actions target `selectedName` (closed over from ?db at render).
  async function policyAction(formData: FormData) {
    "use server";
    const customer = await currentCustomer();
    if (!customer) redirect("/");
    const { userId } = await assertManager();
    if (!selectedName) notFound();
    const raw = formData.get("policy");
    if (typeof raw !== "string") throw new Error("missing policy");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("policy is not valid JSON");
    }
    const policy = parsePolicyOrThrow(parsed);
    const ctx = getMcpProxyContext();
    const result = await setTableAccess(
      customer,
      id,
      policy,
      ctx,
      userId,
      selectedName,
    );
    if (!result) notFound();
    revalidatePath(`/projects/${id}`);
  }

  // Column masking write (design D3). Typed action (not formData) so the
  // Exposure scan can call it with the full next mask set on a one-click mask /
  // unmask. Manager-only; setColumnMasks forces a respawn (masks are boot-time).
  async function columnMasksAction(
    next: unknown,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    "use server";
    const customer = await currentCustomer();
    if (!customer) return { ok: false, error: "not signed in" };
    const { userId } = await assertManager();
    if (!selectedName) return { ok: false, error: "no database selected" };
    let config;
    try {
      config = parseColumnMasksOrThrow(next);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "invalid masks" };
    }
    // Don't let masking fail silently. If this deployment has no
    // MIDPLANE_MASK_SALT_MASTER, the engine refuses to spawn with any mask set
    // (masking would be unenforceable) — so a saved mask would break the
    // project's agent connection later, not now. Refuse the write at save time
    // with a clear error instead. Pure REMOVALS still go through, so a project
    // already stuck on a missing salt can be recovered by unmasking. (The UI
    // also disables the mask controls + shows a banner; this is the backstop for
    // a stale page / direct call.)
    if (!process.env.MIDPLANE_MASK_SALT_MASTER && Object.keys(config).length > 0) {
      const current = await getProjectWithDatabase(customer, id, selectedName);
      const prev = current ? parseColumnMasksOrThrow(current.database.columnMasks) : {};
      if (maskConfigAddsMasking(prev, config)) {
        return {
          ok: false,
          error:
            "Masking isn’t configured on this deployment — set MIDPLANE_MASK_SALT_MASTER. The engine refuses to start with masks until it’s set, so this can’t be saved yet.",
        };
      }
    }
    const ctx = getMcpProxyContext();
    // ET6/B5: best-effort authoring-time type-domain check. Fetch the DB's column
    // types and let setColumnMasks reject a mask that can't apply to a column's type
    // (full-redact on an int, …). Fail OPEN — the customer DB may be unreachable and a
    // save must not depend on it; query-time enforcement is the fail-closed backstop.
    let columnTypes: MaskColumnTypes | undefined;
    if (Object.keys(config).length > 0) {
      try {
        // Credential-bearing fetch (encryptedDsn + kmsKeyId) so the resolver can
        // decrypt; the ciphertext stays server-side.
        const withCred = await getProjectWithDatabaseAndCredential(customer, id, selectedName);
        if (withCred) {
          const decrypt = await ctx.resolver.resolve({
            projectDatabase: withCred.database,
            region: withCred.project.region,
            customerId: withCred.project.customerId,
          });
          if (decrypt.ok) columnTypes = await fetchColumnTypes(decrypt.plaintext);
        }
      } catch {
        // unreachable DB / resolver miss → skip the check, save proceeds.
      }
    }
    // setColumnMasks THROWS on a type-domain violation (noise on a text column,
    // full-redact on an int under source-rewrite, …) and on an engine-side policy
    // reject. Return those as recoverable {ok:false} state — an uncaught throw here
    // escapes the server action and crashes the client, which awaits a SaveResult
    // and (rightly) doesn't wrap the call in try/catch for expected user errors.
    let result;
    try {
      result = await setColumnMasks(customer, id, config, ctx, userId, selectedName, columnTypes);
    } catch (err) {
      const raw = err instanceof Error ? err.message : "couldn’t save masks";
      return { ok: false, error: raw.replace(/^invalid column_masks:\s*/, "") };
    }
    if (!result) return { ok: false, error: "not found" };
    revalidatePath(`/projects/${id}`);
    return { ok: true };
  }

  // PII-scan dismissals (design D1). Typed action like columnMasksAction so the
  // Exposure scan can persist the full next ignored-column set on a dismiss /
  // restore. Manager-only. Unlike masks this is scan-view state, not policy:
  // setIgnoredColumns does no engine respawn and writes no audit row.
  async function ignoredColumnsAction(
    next: unknown,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    "use server";
    const customer = await currentCustomer();
    if (!customer) return { ok: false, error: "not signed in" };
    await assertManager();
    if (!selectedName) return { ok: false, error: "no database selected" };
    let config;
    try {
      config = parseIgnoredColumnsOrThrow(next);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "invalid dismissals" };
    }
    const result = await setIgnoredColumns(customer, id, config, selectedName);
    if (!result) return { ok: false, error: "not found" };
    revalidatePath(`/projects/${id}`);
    return { ok: true };
  }

  // Lazy column-type resolver for the exposure scan (design D3). A masked column
  // that wasn't part of a fresh scan renders with an UNKNOWN type, so the transform
  // picker can't gate type-specific transforms (noise on a text column, …) and would
  // let the user pick one only to have the save rejected. The client calls this on
  // mount to resolve the DB's real Postgres types WITHOUT a full PII scan, so the
  // picker gates correctly up front. Best-effort: a slow/unreachable DB returns null
  // and the picker falls back to "all enabled" + the graceful save-time reject.
  async function columnTypesAction(): Promise<MaskColumnTypes | null> {
    "use server";
    const customer = await currentCustomer();
    if (!customer) return null;
    await assertManager();
    if (!selectedName) return null;
    try {
      const withCred = await getProjectWithDatabaseAndCredential(customer, id, selectedName);
      if (!withCred) return null;
      const decrypt = await getMcpProxyContext().resolver.resolve({
        projectDatabase: withCred.database,
        region: withCred.project.region,
        customerId: withCred.project.customerId,
      });
      if (decrypt.ok) return await fetchColumnTypes(decrypt.plaintext);
    } catch {
      // unreachable DB / resolver miss → null (picker stays permissive; reject is the floor)
    }
    return null;
  }

  async function guardrailsAction(formData: FormData) {
    "use server";
    const customer = await currentCustomer();
    if (!customer) redirect("/");
    const { userId } = await assertManager();
    if (!selectedName) notFound();
    const raw = formData.get("guardrails");
    if (typeof raw !== "string") throw new Error("missing guardrails");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("guardrails is not valid JSON");
    }
    const config = parseGuardrailsOrThrow(parsed);
    const ctx = getMcpProxyContext();
    const result = await setGuardrails(
      customer,
      id,
      config,
      ctx,
      userId,
      selectedName,
    );
    if (!result) notFound();
    revalidatePath(`/projects/${id}`);
  }

  async function rotateAction(formData: FormData) {
    "use server";
    const customer = await currentCustomer();
    if (!customer) redirect("/");
    const { userId } = await assertManager();
    if (!selectedName) notFound();
    const dsn = formData.get("dsn");
    if (!isValidDsn(dsn)) {
      throw new Error("DSN must be a postgres:// or postgresql:// URL");
    }
    const ctx = getMcpProxyContext();
    const rotated = await rotateProject(customer, id, dsn, ctx, selectedName);
    if (!rotated) notFound();
    revalidatePath(`/projects/${id}`);
    if (userId) {
      getPostHog()?.capture({
        distinctId: userId,
        event: "project_rotated",
        properties: {
          project_id: rotated.id,
          region: customer.region,
          source: "project_workspace",
        },
      });
    }
  }

  async function testReachabilityAction(): Promise<{
    ok: boolean;
    error?: string;
  }> {
    "use server";
    const customer = await currentCustomer();
    if (!customer) redirect("/");
    if (!selectedName) return { ok: false, error: "no database selected" };
    const limited = checkRateLimit(
      pingTestKey(customer.id),
      PING_TEST_RATE_LIMIT,
    );
    if (!limited.ok) {
      return { ok: false, error: "too many tests — try again shortly" };
    }
    const result = await getProjectWithDatabaseAndCredential(
      customer,
      id,
      selectedName,
    );
    if (!result) notFound();
    const ctx = getMcpProxyContext();
    const decrypt = await ctx.resolver.resolve({
      projectDatabase: result.database,
      region: result.project.region,
      customerId: result.project.customerId,
    });
    if (!decrypt.ok) {
      return {
        ok: false,
        error:
          "credential unavailable — try again, or rotate the connection string",
      };
    }
    return pingDsnGuarded(decrypt.plaintext);
  }

  async function deleteDatabaseAction() {
    "use server";
    const customer = await currentCustomer();
    if (!customer) redirect("/");
    await assertManager();
    if (!selectedName) notFound();
    const ctx = getMcpProxyContext();
    try {
      const result = await removeDatabase(customer, id, selectedName, ctx);
      if (!result) notFound();
    } catch (err) {
      // Disabled in the UI on the last DB, so this throw is tamper/race-only.
      if (err instanceof LastDatabaseProtected) {
        throw new Error(
          "Can't remove the only database. Add another first or delete the project.",
        );
      }
      throw err;
    }
    revalidatePath("/dashboard");
    revalidatePath(`/projects/${id}`);
    // ?db pointed at the deleted database — drop it so the pane falls back to
    // the first remaining one.
    redirect(`/projects/${id}?section=database`);
  }

  async function renameDatabaseAction(formData: FormData) {
    "use server";
    const customer = await currentCustomer();
    if (!customer) redirect("/");
    await assertManager();
    // oldName comes from the form (the inline editor posts the name it
    // opened on) rather than the closed-over selectedName — they're the same
    // here, but trusting the submitted old name keeps the editor self-
    // contained. The lib re-checks ownership under the hood.
    const oldName = formData.get("name");
    const newName = formData.get("newName");
    if (typeof oldName !== "string" || oldName.length === 0) {
      throw new Error("missing name");
    }
    if (typeof newName !== "string" || !isValidDatabaseName(newName)) {
      throw new Error(
        "Name must be 1–32 lowercase letters / digits / _ - , starting with a letter.",
      );
    }
    const ctx = getMcpProxyContext();
    try {
      const result = await renameDatabase(customer, id, oldName, newName, ctx);
      if (!result) notFound();
    } catch (err) {
      if (err instanceof DatabaseNameTaken) {
        throw new Error(`A database named "${err.takenName}" already exists.`);
      }
      throw err;
    }
    revalidatePath("/dashboard");
    revalidatePath(`/projects/${id}`);
    // The per-DB detail route lives at /databases/[name]; the sibling strip
    // on every per-DB page of this project changes with the rename.
    revalidatePath(`/projects/[id]/databases/[name]`, "page");
    // The control navigates to ?db=<newName> client-side; no redirect here
    // (it runs inside a client transition that would swallow NEXT_REDIRECT).
  }

  // ---- panes -------------------------------------------------------------

  // Members see the database list (read-only) and a pointer to who manages the
  // controls — never the policy/guardrails editors or the rename/rotate/delete
  // actions. The DatabaseStrip's add affordance is suppressed (showAdd={false}).
  const memberDatabasePane = selDb ? (
    <>
      <DatabaseStrip
        databases={dbNames}
        current={selDb.name}
        projectId={conn.id}
        addAction={addDatabaseAction}
        showAdd={false}
      />
      <p className="text-sm text-muted-foreground">
        Table permissions and guardrails for this database are managed by an
        owner or admin.
      </p>
    </>
  ) : null;

  const managerDatabasePane = selDb ? (
    <>
      <DatabaseStrip
        databases={dbNames}
        current={selDb.name}
        projectId={conn.id}
        addAction={addDatabaseAction}
      />
      <div className="space-y-6">
      <div className="space-y-3">
        <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-subtle">
          Policy
        </span>
      <section className={CARD}>
        <h2 className="text-base font-medium text-foreground">
          Table permissions
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Per-table read / write policy enforced by the Midplane engine.{" "}
          <strong className="font-medium text-foreground">
            Changes take effect immediately
          </strong>{" "}
          — the engine hot-swaps the policy on the next agent request, without
          interrupting active sessions.
        </p>
        <div className="pt-3">
          {/* key: the editors hold form state in useState — without a
              remount on ?db= switch, React keeps the PREVIOUS database's
              values and dirty baseline at the same tree position, and
              Save would post them to the newly selected db. */}
          <PermissionGrid
            key={selDb.name}
            projectId={conn.id}
            dbName={selDb.name}
            initialPolicy={parsePolicyOrThrow(selDb.tableAccess)}
            action={policyAction}
          />
        </div>
      </section>

      <section className={CARD}>
        <h2 className="text-base font-medium text-foreground">Guardrails</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Categorical blocks for destructive statements,{" "}
          <strong className="font-medium text-foreground">
            enforced regardless of the table permissions above
          </strong>
          . An agent with write access still can&apos;t wipe a table or drop
          the schema unless you allow it here.
        </p>
        <div className="pt-3">
          <GuardrailsToggles
            key={selDb.name}
            initialConfig={parseGuardrailsOrThrow(selDb.guardrails)}
            action={guardrailsAction}
          />
        </div>
      </section>

      </div>

      <TestPolicyPanel
        projectId={conn.id}
        databases={[
          {
            name: selDb.name,
            policy: parsePolicyOrThrow(selDb.tableAccess),
            guardrails: parseGuardrailsOrThrow(selDb.guardrails),
          },
        ]}
        reachabilitySlot={
          <TestReachabilityButton action={testReachabilityAction} />
        }
      />

      <div className="space-y-2 pt-2">
        <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-subtle">
          Actions
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <RenameDatabaseControl
            projectId={conn.id}
            name={selDb.name}
            action={renameDatabaseAction}
          />
          <RotateCredentialSheet
            id={conn.id}
            dbName={selDb.name}
            action={rotateAction}
            lastRotatedLabel={
              selDb.rotatedAt
                ? `Last rotated ${formatRelative(selDb.rotatedAt)}.`
                : undefined
            }
          />
          <DeleteDatabaseButton
            name={selDb.name}
            action={deleteDatabaseAction}
            disabled={dbNames.length <= 1}
          />
        </div>
        {dbNames.length <= 1 ? (
          <p className="text-xs text-subtle">
            Delete is unavailable on the only database — add another, or delete
            the whole project from Settings.
          </p>
        ) : null}
      </div>
      </div>
    </>
  ) : null;

  const databasePane = !selDb ? (
    <p className="text-sm text-muted-foreground">
      No database on this project yet.
    </p>
  ) : canManage ? (
    managerDatabasePane
  ) : (
    memberDatabasePane
  );

  // PII exposure scan (design D1). Per-DB (reuses the ?db switcher) and
  // manager-gated like the policy editor — the scan reads the customer's schema.
  const exposurePane = !selDb ? (
    <p className="text-sm text-muted-foreground">No database on this project yet.</p>
  ) : (
    <>
      <DatabaseStrip
        databases={dbNames}
        current={selDb.name}
        projectId={conn.id}
        addAction={addDatabaseAction}
        showAdd={canManage}
      />
      {canManage ? (
        <div className="space-y-8">
          <div className="space-y-3">
            <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-subtle">
              PII exposure
            </span>
            {/* key remounts on ?db switch so the fetched scan tracks the selected db */}
            <ExposureScan
              key={selDb.name}
              projectId={conn.id}
              db={selDb.name}
              maskingConfigured={!!process.env.MIDPLANE_MASK_SALT_MASTER}
              initialMasks={parseColumnMasksOrThrow(selDb.columnMasks)}
              initialIgnored={parseIgnoredColumnsOrThrow(selDb.ignoredColumns)}
              onSave={columnMasksAction}
              onSaveIgnored={ignoredColumnsAction}
              onLoadColumnTypes={columnTypesAction}
            />
          </div>

          {/* Masked preview (design D2): the proof that masking works — run a
              real read-only SELECT through the engine and see the agent's-eye
              (masked) rows, or the fail-closed rejection. */}
          <div className="space-y-3">
            <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-subtle">
              Masked preview
            </span>
            <MaskedPreviewPanel
              key={selDb.name}
              projectId={conn.id}
              database={selDb.name}
              columnMasks={parseColumnMasksOrThrow(selDb.columnMasks)}
            />
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          The exposure scan is available to an owner or admin.
        </p>
      )}
    </>
  );

  const connectPane = (
    <div className="space-y-6">
      {justCreated ? (
        <div
          role="status"
          className="rounded-md border border-[hsl(var(--allow)/0.4)] bg-[hsl(var(--allow)/0.08)] px-3 py-2 text-xs text-[hsl(var(--allow))]"
        >
          Project created. Connect your first agent below — point it at the URL
          and sign in.
        </div>
      ) : null}

      {/* The connect card owns the "how to connect" instructions (OAuth URL +
          per-client config). One card, shown once. The agent it grants is bound
          to THIS project's databases at sign-in; the URL itself isn't a secret. */}
      <OAuthConnectGuide projectName={conn.name} mcpUrl={mcpUrl} />

      {/* The connected-agents list (OAuth clients + machine tokens, each with
          its DB scope + revoke). Management is owner/admin only, so members see
          the connect card above but not this list — they connect via OAuth. */}
      {canManage && (
        <AgentList
          projectId={conn.id}
          agents={agents}
          databases={databases.map((d) => ({
            projectDatabaseId: d.id,
            name: d.name,
          }))}
          createAction={createTokenAction}
          revokeAction={revokeTokenAction}
          tokenLimit={tokenLimit}
        />
      )}
    </div>
  );

  const settingsPane = (
    <div className="space-y-6">
      <section className={`${CARD} space-y-5`}>
        <div className="space-y-2">
          <Label>Name</Label>
          <div className="flex min-h-9 items-center">
            {canManage ? (
              <RenameProjectInline
                id={conn.id}
                initialName={conn.name}
                placeholder="Untitled project"
                action={renameAction}
              />
            ) : (
              <span className="text-sm text-foreground">{label}</span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {canManage
              ? "Shown across the dashboard and audit log. Click to edit."
              : "Shown across the dashboard."}
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="conn-region">Region</Label>
          <Input id="conn-region" readOnly value={REGION_LABELS[conn.region]} />
          <p className="text-xs text-muted-foreground">
            Set when the project was created and not editable.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="conn-id">Project ID</Label>
          <Input id="conn-id" readOnly value={conn.id} className="font-mono" />
        </div>
      </section>

      {/* Service (pause/resume) and Delete are owner/admin only — a member can
          view the project and connect an agent, but can't take it down or
          delete it. */}
      {canManage && (
        <>
      {/* Service — the reversible kill switch. Sits above the danger zone
          because it's recoverable: pausing rejects agent requests but keeps
          tokens, URLs, and policy intact; resume restores service. */}
      <section
        className={`${CARD} space-y-3 ${paused ? "border-[hsl(var(--warn)/0.4)]" : ""}`}
      >
        <div className="flex items-center gap-2">
          <h2 className="text-base font-medium text-foreground">Service</h2>
          {paused ? (
            <Badge variant="warn" withDot>
              Paused
            </Badge>
          ) : null}
        </div>
        {paused ? (
          <>
            <p className="text-xs text-muted-foreground">
              Agent requests are being{" "}
              <strong className="font-medium text-foreground">rejected</strong>.
              Tokens, URLs, and policy are untouched — resume to restore service
              with the same URLs.
            </p>
            <form action={resumeAction}>
              <input type="hidden" name="id" value={conn.id} />
              <Button type="submit" variant="outline" size="sm">
                Resume project
              </Button>
            </form>
          </>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              Reject every agent request without deleting anything — a
              reversible kill switch.{" "}
              <strong className="font-medium text-foreground">
                Tokens, URLs, and policy stay intact
              </strong>{" "}
              and resume restores service instantly. The running session is
              dropped immediately.
            </p>
            <PauseProjectButton id={conn.id} action={pauseAction} />
          </>
        )}
      </section>

      <section className={`${CARD} space-y-3 border-[hsl(var(--deny)/0.4)]`}>
        <h2 className="text-base font-medium text-foreground">
          Delete project
        </h2>
        <p className="text-xs text-muted-foreground">
          Stops the MCP endpoint and removes the encrypted row.{" "}
          <strong className="font-medium text-foreground">
            All tokens on this project are revoked.
          </strong>{" "}
          Audit history stays in the dashboard for compliance.
        </p>
        <DeleteProjectButton id={conn.id} action={deleteAction} />
      </section>
        </>
      )}
    </div>
  );

  const railHeader = (
    <div>
      <div className="text-sm font-medium leading-snug tracking-tight text-foreground break-words">
        {label}
      </div>
      <div className="mt-1.5">
        <ServingStatus
          projectId={conn.id}
          pausedAt={conn.pausedAt}
          databaseCount={databases.length}
          cursor={cursor}
          testDatabase={selectedName}
          canManage={canManage}
        />
      </div>
      {paused && canManage ? (
        // Resume lives in the rail header so it's one click from any pane,
        // not buried in Settings — the kill switch should be as easy to undo
        // as it was to flip. Members can't resume, so they see the status line
        // (the freshness dot above already reads "Paused").
        <form action={resumeAction} className="mt-2">
          <input type="hidden" name="id" value={conn.id} />
          <Button type="submit" variant="outline" size="sm" className="w-full">
            Resume
          </Button>
        </form>
      ) : (
        <p className="mt-2 text-[11px] leading-snug text-subtle">
          Hosted MCP server
        </p>
      )}
    </div>
  );

  return (
    <>
      <Topbar>
        <Breadcrumb
          items={[{ label: "Projects", href: "/dashboard" }, { label }]}
        />
      </Topbar>
      <PageContainer>
        <div className="mx-auto max-w-[1100px]">
          <ProjectRail
            initialSection={initialSection}
            header={railHeader}
            panes={{
              database: databasePane,
              exposure: exposurePane,
              connect: connectPane,
              settings: settingsPane,
            }}
          />
        </div>
      </PageContainer>
    </>
  );
}
