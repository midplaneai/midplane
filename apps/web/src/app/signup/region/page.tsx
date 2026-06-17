import { getOrgContext } from "@/lib/org-context";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getPostHog } from "@/lib/posthog";

import { BrandLockup } from "@/components/layout/brand-mark";
import { Button } from "@/components/ui/button";
import { defaultRegionForCountry, REGION_LABELS } from "@/lib/region";
import { upsertCustomerRegion } from "@/lib/customer";
import { bootRegion } from "@/lib/region-context";
import type { Region } from "@midplane-cloud/kms";

// Region picker. Three entry points:
//   - Apex (app.midplane.ai) unauth: show picker; submit redirects to the
//     regional /sign-up so Clerk signup happens on the correct app.
//   - Apex auth: middleware already redirected to the regional subdomain,
//     so this branch is unreachable via apex when authenticated.
//   - Regional subdomain auth (post-Clerk-signup): show picker; submit
//     writes the customer row + Clerk org metadata against this regional
//     app's DB, then redirects to /dashboard.

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

// Auth path: user just completed Clerk sign-up on a regional subdomain (or
// is correcting a missing publicMetadata.region claim). Write the customer
// row + Clerk org metadata against this regional app's DB. If the picked
// region doesn't match the app this request landed on (e.g. user wanted
// US but submitted on EU), redirect them to the matching regional app's
// picker instead of writing wrong-region data.
async function pickRegionAuthed(formData: FormData) {
  "use server";
  const region = formData.get("region");
  if (region !== "eu" && region !== "us") {
    throw new Error("invalid region");
  }
  const appRegion = bootRegion();
  if (region !== appRegion) {
    // Cross-region pick on the wrong regional app — redirect to the
    // matching app's picker with the choice preserved. The destination
    // app's middleware will gate auth (Clerk session is .midplane.ai-
    // scoped so it carries across subdomains).
    const target =
      region === "eu"
        ? "https://eu.app.midplane.ai/signup/region"
        : "https://us.app.midplane.ai/signup/region";
    redirect(target);
  }
  const { userId } = await getOrgContext();
  const customer = await upsertCustomerRegion(region);

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

// Unauth path: visitor on apex picked a region before signing up. Redirect
// to the regional subdomain's /sign-up so Clerk signup runs on the right
// app — after sign-up, Clerk's afterSignUpUrl lands them back on
// /signup/region and the auth path above completes the write.
async function pickRegionUnauth(formData: FormData) {
  "use server";
  const region = formData.get("region");
  if (region !== "eu" && region !== "us") {
    throw new Error("invalid region");
  }
  const target =
    region === "eu"
      ? "https://eu.app.midplane.ai/sign-up?redirect_url=/signup/region"
      : "https://us.app.midplane.ai/sign-up?redirect_url=/signup/region";
  redirect(target);
}
