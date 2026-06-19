import { assertManager, isManager } from "@/lib/org-auth";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import {
  parseGuardrailsOrThrow,
  parsePolicyOrThrow,
} from "@midplane-cloud/db";
import { mcpGenericUrl, mcpProjectUrl } from "@midplane-cloud/router";

import { ProjectRail } from "@/components/projects/project-rail";
import { OAuthConnectGuide } from "@/components/projects/oauth-connect-guide";
import {
  PROJECT_SECTIONS,
  type ProjectSection,
} from "@/components/projects/project-sections";
import { DatabaseStrip } from "@/components/projects/database-strip";
import { DeleteDatabaseButton } from "@/components/projects/delete-database-button";
import { TestPolicyPanel } from "@/components/projects/test-policy-panel";
import { TestReachabilityButton } from "@/components/projects/test-reachability-button";
import { FreshnessDot } from "@/components/dashboard/freshness-dot";
import { RenameProjectInline } from "@/components/dashboard/rename-project-inline";
import { DeleteProjectButton } from "@/components/delete-project-button";
import { PauseProjectButton } from "@/components/projects/pause-project-button";
import { GuardrailsToggles } from "@/components/guardrails-toggles";
import { Topbar, PageContainer } from "@/components/layout/app-shell";
import { PermissionGrid } from "@/components/permission-grid";
import { RenameDatabaseControl } from "@/components/projects/rename-database-control";
import { RotateCredentialSheet } from "@/components/projects/rotate-credential-sheet";
import { TokenList } from "@/components/tokens/token-list";
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
  isValidDatabaseName,
  isValidDsn,
  LastDatabaseProtected,
  pauseProject,
  removeDatabase,
  renameProject,
  renameDatabase,
  resumeProject,
  rotateProject,
  setGuardrails,
  setTableAccess,
} from "@/lib/projects";
import { currentCustomer } from "@/lib/customer";
import { addDatabaseFromForm } from "@/lib/database-form";
import { projectLabel, formatRelative } from "@/lib/format";
import { resolveFreshness, FRESHNESS_LABELS } from "@/lib/freshness";
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
import { listTokens } from "@/lib/tokens";

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
  searchParams: Promise<{ section?: string; db?: string }>;
}) {
  const customer = await currentCustomer();
  if (!customer) redirect("/signup/region");

  // Owner/admin manage the project (policy, guardrails, tokens, DSN, databases,
  // delete); a member can view it and connect their agent (OAuth) but sees no
  // management controls. Each mutating action below also re-checks server-side.
  const canManage = await isManager();

  const { id } = await params;
  const { section, db } = await searchParams;
  const initialSection: ProjectSection = SECTION_VALUES.includes(
    section as ProjectSection,
  )
    ? (section as ProjectSection)
    : // A member's useful landing is their connect URL, not the (hidden)
      // table-permissions editor — default them to the Agents pane.
      canManage
      ? "database"
      : "agents";

  const { plan, caps } = await resolvePlan();
  const [home, tokens, usage] = await Promise.all([
    getProjectHomeData(customer, id, caps.auditRetentionDays),
    listTokens(customer, id),
    getPlanUsage(customer),
  ]);
  if (!home) notFound();
  const { project: conn, databases, cursor } = home;
  if (tokens === null) notFound();

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

  // Pause is a project-level override of the freshness dot: a paused
  // project reads amber/"Paused" regardless of indexer state (see
  // resolveFreshness — the same shared override the dashboard applies), and
  // the rail header (visible from every pane) exposes one-click Resume.
  const paused = conn.pausedAt != null;
  const railFreshness = resolveFreshness(cursor, conn.pausedAt);
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

  // This project's OAuth MCP endpoint — /mcp/<projectId>. Non-secret
  // (auth is the OAuth sign-in), so it's shown openly with a copy button.
  const mcpUrl = mcpProjectUrl(conn.region, conn.id, process.env);
  // The region-wide OAuth endpoint — /mcp (no id, no token), the default the
  // connect snippets lead with. Computed here (server) so it uses this
  // deployment's real MCP host, not a hardcoded *.midplane.ai.
  const oauthMcpUrl = mcpGenericUrl(conn.region, process.env);

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
            Saving stops the running session
          </strong>{" "}
          so the new policy takes effect on the next agent request.
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

  const agentsPane = (
    <div className="space-y-8">
      {/* Interactive agents (Claude Code, Cursor, Claude Desktop) — OAuth. The
          human signs in once; the endpoint URL isn't a secret. */}
      <section className="space-y-3">
        <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-subtle">
          Interactive agents
        </span>
        <OAuthConnectGuide projectName={conn.name} mcpUrl={mcpUrl} />
      </section>

      {/* Headless agents (CI, scheduled jobs, unattended workflows) — a stored
          API-token secret, since there's no browser to sign in. Minting and
          revoking tokens is owner/admin only, so the whole surface is hidden
          from members (who connect via the OAuth guide above). */}
      {canManage && (
        <section className="space-y-3">
          <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-subtle">
            Headless agents
          </span>
          <p className="text-xs text-muted-foreground">
            For CI, scheduled jobs, or unattended workflows that can&apos;t do a
            browser sign-in. Mint a token, store it as a secret, and revoke it
            the moment a laptop or runner is compromised.
          </p>
          <TokenList
            projectId={conn.id}
            projectName={conn.name}
            oauthUrl={oauthMcpUrl}
            databases={databases.map((d) => ({
              projectDatabaseId: d.id,
              name: d.name,
            }))}
            tokens={tokens}
            createAction={createTokenAction}
            revokeAction={revokeTokenAction}
            tokenLimit={tokenLimit}
          />
        </section>
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
      <div className="mt-1.5 flex items-center gap-1.5">
        <FreshnessDot state={railFreshness} />
        <span className="text-xs capitalize text-muted-foreground">
          {FRESHNESS_LABELS[railFreshness]}
        </span>
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
              agents: agentsPane,
              settings: settingsPane,
            }}
          />
        </div>
      </PageContainer>
    </>
  );
}
