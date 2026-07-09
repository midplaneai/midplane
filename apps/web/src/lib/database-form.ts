import "server-only";

import { notFound } from "next/navigation";

import { ACCESS_LEVELS, type AccessLevel } from "@midplane-cloud/db/policy";

import {
  addDatabase,
  DatabaseNameTaken,
  isValidDatabaseName,
  isValidDsn,
} from "@/lib/projects";
import type { Customer } from "@midplane-cloud/db";
import { getMcpProxyContext } from "@/lib/mcp-proxy";
import { PlanLimitError, resolvePlanFor } from "@/lib/plan";

// Shared body of the add-database server action. The project
// workspace's Database pane posts the AddDatabaseForm (via AddDatabaseSheet);
// its thin "use server" action (actions must live in server files) delegates
// here and then revalidates its own paths. Kept shared so any future surface
// that grows a database posts the same validated path.
//
// Error contract: throws Error with a user-renderable message — the
// client form wraps the action in try/catch and renders inline (see
// add-database-form.tsx). Tamper-shaped failures (missing projectId)
// also throw; they're not reachable through the real form.
//
// Callers' revalidation duty: besides their own surface, membership
// changes alter EVERY per-DB page of the project (the sibling strip
// in databases/[name]/layout.tsx renders the db list) — revalidate the
// bracketed page path too.

export async function addDatabaseFromForm(
  customer: Customer,
  formData: FormData,
): Promise<{ projectId: string; name: string }> {
  const projectId = formData.get("projectId");
  if (typeof projectId !== "string" || projectId.length === 0) {
    throw new Error("missing projectId");
  }
  const nameRaw = formData.get("name");
  if (typeof nameRaw !== "string" || !isValidDatabaseName(nameRaw.trim())) {
    throw new Error(
      "Name must be 1–32 lowercase letters / digits / _ - , starting with a letter.",
    );
  }
  const dbName = nameRaw.trim();
  const dsn = formData.get("dsn");
  if (!isValidDsn(dsn)) {
    throw new Error("DSN must be a postgres:// or postgresql:// URL");
  }
  // The form posts a string; validate against the canonical enum so a
  // tampered request can't smuggle in something the spawner would
  // refuse. Missing field falls back to "read" — same posture as
  // createProject.
  const accessRaw = formData.get("default_access");
  const defaultAccess: AccessLevel =
    typeof accessRaw === "string" &&
    (ACCESS_LEVELS as readonly string[]).includes(accessRaw)
      ? (accessRaw as AccessLevel)
      : "read";

  const ctx = getMcpProxyContext();
  // Sync resolution from the customer already in hand — resolvePlan() would
  // re-resolve the session + re-read the customers row on every submit.
  const entitlement = resolvePlanFor(customer);
  try {
    const result = await addDatabase(
      customer,
      projectId,
      dbName,
      dsn,
      defaultAccess,
      entitlement,
      ctx,
    );
    if (!result) notFound();
  } catch (err) {
    if (err instanceof DatabaseNameTaken) {
      throw new Error(`A database named "${err.takenName}" already exists.`);
    }
    if (err instanceof PlanLimitError) {
      // Normally unreachable through the UI — the DatabaseStrip swaps the
      // add affordance for the upgrade CTA at the cap — but the authoritative
      // check still needs a renderable message for races / stale pages.
      throw new Error(
        `Your ${err.plan} plan includes ${err.limit} databases per project. Upgrade on the Billing page to add more.`,
      );
    }
    throw err;
  }
  return { projectId, name: dbName };
}
