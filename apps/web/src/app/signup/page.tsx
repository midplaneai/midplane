import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { getAuth } from "@/lib/auth";
import { getOrgContext } from "@/lib/org-context";
import { getPostHog } from "@/lib/posthog";

import { BrandLockup } from "@/components/layout/brand-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RegionBadge } from "@/components/ui/region-badge";
import { RegionFlag } from "@/components/ui/region-flag";
import { defaultRegionForCountry, REGION_LABELS } from "@/lib/region";
import { upsertCustomerRegion } from "@/lib/customer";
import { bootRegion } from "@/lib/region-context";
import { isSelfHost } from "@/lib/self-host";
import { suggestWorkspaceName } from "@/lib/workspace-name";
import {
  APEX_HOST,
  REGION_COOKIE,
  REGION_HOST,
  regionCookieOptions,
  signRegionCookieValue,
} from "@/lib/region-routing";
import type { Region } from "@midplane-cloud/kms";

// Region picker / signup-completion step. Two entry points:
//   - Unauth: pick which regional app to sign up on; submit routes to /sign-up.
//   - Authed (post-signup): the region is ALREADY fixed to the regional app the
//     user signed up on (auth + data are region-resident — there's no way to
//     move an authenticated session to the other region). So this just collects
//     the workspace name, creates the org (Better Auth doesn't auto-create one)
//     + writes the customer row in this region, then redirects to /dashboard.

export default async function RegionPicker() {
  // Self-host has one region and one implicit customer — there is no region to
  // pick and no org to create. currentCustomer() already resolves authed users,
  // so the (app) layout never sends anyone here; this guards a direct visit.
  if (isSelfHost()) redirect("/dashboard");

  const h = await headers();
  // Read the session once: drives the auth/unauth branch AND the workspace-name
  // suggestion (email domain → company, or the person's name for generic
  // providers). Unauth visitors picked region before signup, so there's no
  // session yet and no workspace field — the name is set on the authed pass.
  const session = await getAuth().api.getSession({ headers: h });
  const userId = session?.user.id ?? null;
  const suggestedWorkspace = session
    ? suggestWorkspaceName(session.user.email, session.user.name)
    : "";

  // Vercel/Cloudflare-style country header, falls through to nothing in dev.
  const country =
    h.get("x-vercel-ip-country") ??
    h.get("cf-ipcountry") ??
    h.get("x-country") ??
    null;
  const suggested = defaultRegionForCountry(country);
  // An authed user's region is fixed to the regional app they signed up on.
  const appRegion = bootRegion();

  const action = userId ? pickRegionAuthed : pickRegionUnauth;

  return (
    <main className="flex min-h-screen flex-col">
      <header className="border-b border-border px-10 py-5">
        <BrandLockup />
      </header>

      <section className="container mx-auto flex max-w-[760px] flex-1 flex-col items-center justify-center gap-8 px-4 py-16">
        <div className="space-y-3 text-center">
          <h1 className="text-3xl font-semibold tracking-[-0.025em] text-foreground">
            {userId ? "Set up your workspace" : "Pick your data region"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {userId
              ? "Your audit log and encrypted credentials live in this region. It's fixed to the region you signed up on and can't be changed later."
              : "Your audit log and encrypted credentials live in this region. This choice is permanent — we can't move an account between regions."}
          </p>
        </div>

        <form
          action={action}
          className="grid w-full grid-cols-1 gap-4 sm:grid-cols-2"
        >
          {userId ? (
            <>
              <div className="space-y-2 text-left sm:col-span-2">
                <Label htmlFor="workspaceName">Workspace name</Label>
                <Input
                  id="workspaceName"
                  name="workspaceName"
                  defaultValue={suggestedWorkspace}
                  maxLength={100}
                  required
                  autoComplete="organization"
                />
                <p className="text-xs text-muted-foreground">
                  You can rename this later.
                </p>
              </div>
              {/* Region is fixed to the app the user authenticated on — shown
                  read-only, not a choice (region-resident auth). */}
              <div className="space-y-2 text-left sm:col-span-2">
                <Label>Data region</Label>
                <div className="flex items-center gap-2.5 rounded-lg border border-border bg-card p-4">
                  <RegionFlag region={appRegion} />
                  <RegionBadge region={appRegion} />
                  <span className="text-sm text-muted-foreground">
                    {REGION_LABELS[appRegion]} — permanent.
                  </span>
                </div>
              </div>
            </>
          ) : (
            <>
              <RegionCard region="eu" suggested={suggested} />
              <RegionCard region="us" suggested={suggested} />
            </>
          )}
          <Button type="submit" className="sm:col-span-2" size="lg">
            Continue
          </Button>
        </form>
      </section>
    </main>
  );
}

function RegionCard({
  region,
  suggested,
}: {
  region: Region;
  suggested: Region | null;
}) {
  return (
    <label className="flex cursor-pointer flex-col gap-2 rounded-lg border border-border bg-card p-4 transition-colors has-[:checked]:border-[hsl(var(--brand))] has-[:checked]:ring-2 has-[:checked]:ring-ring">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 font-medium text-foreground">
          <RegionFlag region={region} />
          {REGION_LABELS[region]}
        </span>
        {region === suggested && (
          <span className="text-xs text-muted-foreground">Suggested</span>
        )}
      </div>
      <input
        type="radio"
        name="region"
        value={region}
        defaultChecked={region === suggested}
        className="sr-only"
        required
      />
      <span className="text-sm text-muted-foreground">
        {region === "eu"
          ? "Data residency in the EU. AWS eu-central-1."
          : "AWS us-east-2."}
      </span>
    </label>
  );
}

// Auth path: user just completed sign-up. Create the org (if needed) + write
// the customer row in THIS region. The region is authoritative — it's the
// regional app the user authenticated on; auth + data are region-resident, so
// there's no cross-region move (the old redirect stranded the session, which
// the destination app — reading its own regional auth DB — saw as unauthed).
async function pickRegionAuthed(formData: FormData) {
  "use server";
  const region = bootRegion();
  // Workspace name from the form (prefilled with a smart default, editable).
  // Blank → upsertCustomerRegion derives one. Capped to a sane length.
  const workspaceName = formData.get("workspaceName");
  const orgName =
    typeof workspaceName === "string"
      ? workspaceName.trim().slice(0, 100)
      : "";

  const { userId } = await getOrgContext();
  const customer = await upsertCustomerRegion(region, orgName || undefined);

  // Set the signed region cookie alongside the DB write — this is the routing
  // fast-path the middleware reads to send the user to their regional subdomain
  // (and bounce cross-region requests) with no DB lookup.
  //
  // This is an optimization, not a correctness requirement: the org + customer
  // row are already committed above, and the middleware falls back to a DB
  // lookup when the cookie is absent. So a signing failure here (e.g. a
  // misconfigured MIDPLANE_REGION_COOKIE_SECRET) must NOT take down the user's
  // very first action with a 500 — degrade gracefully and still land them in the
  // app. (This is the exact failure that 500'd every new signup when the secret
  // was unset in prod.)
  try {
    const cookieStore = await cookies();
    cookieStore.set(
      REGION_COOKIE,
      await signRegionCookieValue(region),
      regionCookieOptions(),
    );
  } catch (err) {
    console.error("signup: failed to set region cookie (continuing)", err);
  }

  const posthog = getPostHog();
  if (posthog && userId) {
    posthog.identify({
      distinctId: userId,
      properties: {
        $set: { email: customer.email, region: customer.region },
        $set_once: { signup_region: customer.region },
      },
    });
    posthog.capture({
      distinctId: userId,
      event: "signup_completed",
      properties: {
        region: customer.region,
      },
    });
  }
  redirect("/dashboard");
}

// Unauth path: visitor picked a region before signing up. Route to /sign-up,
// then back here (authed) to complete the write. Regional-subdomain routing
// for the pre-auth pick returns with the signed region cookie in a later step;
// for now the region is chosen on the authed pass.
async function pickRegionUnauth(formData: FormData) {
  "use server";
  const region = formData.get("region");
  if (region !== "eu" && region !== "us") {
    throw new Error("invalid region");
  }
  // Route to the CHOSEN region's app so signup (and its region-resident auth
  // data) lands on the right one; the authed pass then writes the customer row +
  // region cookie. This must fire on the apex AND on a regional host: a user can
  // reach a regional /signup via the sign-in "Create account" link (e.g. after
  // the apex email-router sent an unrecognized email to us.app/sign-in), and
  // picking the OTHER region there must actually move them, not pin them to
  // whichever regional app they happen to be on. Only dev/self-host (host is not
  // a known cloud host, so the regional subdomains aren't reachable) stays
  // relative.
  const host = (await headers()).get("host");
  const isCloudHost =
    host === APEX_HOST || host === REGION_HOST.eu || host === REGION_HOST.us;
  if (isCloudHost) {
    redirect(`https://${REGION_HOST[region]}/sign-up?redirect=/signup`);
  }
  redirect("/sign-up?redirect=/signup");
}
