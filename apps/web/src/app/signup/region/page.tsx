import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { getOrgContext } from "@/lib/org-context";
import { getPostHog } from "@/lib/posthog";

import { BrandLockup } from "@/components/layout/brand-mark";
import { Button } from "@/components/ui/button";
import { defaultRegionForCountry, REGION_LABELS } from "@/lib/region";
import { upsertCustomerRegion } from "@/lib/customer";
import { bootRegion } from "@/lib/region-context";
import {
  APEX_HOST,
  REGION_COOKIE,
  REGION_HOST,
  regionCookieOptions,
  signRegionCookieValue,
} from "@/lib/region-routing";
import type { Region } from "@midplane-cloud/kms";

// Region picker — the signup-completion step. Two entry points:
//   - Unauth: show picker; submit routes to /sign-up, then back here authed.
//   - Authed (post-signup): show picker; submit creates the org (Better Auth
//     doesn't auto-create one) + writes the customer row against the chosen
//     region's DB, then redirects to /dashboard.
// Regional-subdomain routing (apex → region host) returns with the signed
// region cookie in a later step; here the chosen region is written directly.

export default async function RegionPicker() {
  const { userId } = await getOrgContext();

  const h = await headers();
  // Vercel/Cloudflare-style country header, falls through to nothing in dev.
  const country =
    h.get("x-vercel-ip-country") ??
    h.get("cf-ipcountry") ??
    h.get("x-country") ??
    null;
  const suggested = defaultRegionForCountry(country);

  const action = userId ? pickRegionAuthed : pickRegionUnauth;

  return (
    <main className="flex min-h-screen flex-col">
      <header className="border-b border-border px-10 py-5">
        <BrandLockup />
      </header>

      <section className="container mx-auto flex max-w-[760px] flex-1 flex-col items-center justify-center gap-8 px-4 py-16">
        <div className="space-y-3 text-center">
          <h1 className="text-3xl font-semibold tracking-[-0.025em] text-foreground">
            Pick your data region
          </h1>
          <p className="text-sm text-muted-foreground">
            Your audit log and encrypted credentials live in this region. This
            choice is permanent — we can&apos;t move an account between regions.
          </p>
        </div>

        <form
          action={action}
          className="grid w-full grid-cols-1 gap-4 sm:grid-cols-2"
        >
          <RegionCard region="eu" suggested={suggested} />
          <RegionCard region="us" suggested={suggested} />
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
        <span className="font-medium text-foreground">
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
// the customer row against the chosen region's DB. If the picked region
// doesn't match the regional app this request landed on, redirect to the
// matching app's picker instead of writing wrong-region data.
async function pickRegionAuthed(formData: FormData) {
  "use server";
  const region = formData.get("region");
  if (region !== "eu" && region !== "us") {
    throw new Error("invalid region");
  }
  const appRegion = bootRegion();
  if (region !== appRegion) {
    // Cross-region pick on the wrong regional app — redirect to the matching
    // app's picker with the choice preserved. The region cookie is
    // .app.midplane.ai-scoped so it carries across subdomains.
    redirect(`https://${REGION_HOST[region]}/signup/region`);
  }
  const { userId } = await getOrgContext();
  const customer = await upsertCustomerRegion(region);

  // Set the signed region cookie alongside the DB write — this is the routing
  // fast-path the middleware reads to send the user to their regional subdomain
  // (and bounce cross-region requests) with no DB lookup.
  const cookieStore = await cookies();
  cookieStore.set(
    REGION_COOKIE,
    await signRegionCookieValue(region),
    regionCookieOptions(),
  );

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
  // On the apex, route to the chosen region's subdomain so signup (and its
  // region-resident auth data) lands on the right app; the authed pass then
  // writes the customer row + region cookie. On a regional app / dev single
  // host, stay relative.
  const host = (await headers()).get("host");
  if (host === APEX_HOST) {
    redirect(`https://${REGION_HOST[region]}/sign-up?redirect=/signup/region`);
  }
  redirect("/sign-up?redirect=/signup/region");
}
