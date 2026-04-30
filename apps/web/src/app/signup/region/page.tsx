import { auth } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import { defaultRegionForCountry, REGION_LABELS } from "@/lib/region";
import { upsertCustomerRegion } from "@/lib/customer";
import type { Region } from "@midplane-cloud/kms";

export default async function RegionPicker() {
  const { userId } = await auth();
  if (!userId) redirect("/");

  const h = await headers();
  // Vercel/Cloudflare-style country header, falls through to nothing in dev.
  const country =
    h.get("x-vercel-ip-country") ??
    h.get("cf-ipcountry") ??
    h.get("x-country") ??
    null;
  const suggested = defaultRegionForCountry(country);

  return (
    <main className="container mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-8 px-4">
      <div className="space-y-3 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">
          Pick your data region
        </h1>
        <p className="text-muted-foreground">
          Your audit log and encrypted credentials live in this region. We
          can&apos;t change it later — region migration is a V2 feature.
        </p>
      </div>

      <form
        action={pickRegion}
        className="grid w-full grid-cols-1 gap-4 sm:grid-cols-2"
      >
        <RegionCard region="fra" suggested={suggested} />
        <RegionCard region="iad" suggested={suggested} />
        <Button type="submit" className="sm:col-span-2" size="lg">
          Continue
        </Button>
      </form>
    </main>
  );
}

function RegionCard({
  region,
  suggested,
}: {
  region: Region;
  suggested: Region;
}) {
  return (
    <label className="flex cursor-pointer flex-col gap-2 rounded-lg border bg-card p-4 transition-colors has-[:checked]:border-primary has-[:checked]:ring-2 has-[:checked]:ring-ring">
      <div className="flex items-center justify-between">
        <span className="font-medium">{REGION_LABELS[region]}</span>
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
        {region === "fra"
          ? "Data residency in the EU. AWS eu-central-1."
          : "AWS us-east-2."}
      </span>
    </label>
  );
}

async function pickRegion(formData: FormData) {
  "use server";
  const region = formData.get("region");
  if (region !== "fra" && region !== "iad") {
    throw new Error("invalid region");
  }
  await upsertCustomerRegion(region);
  redirect("/dashboard");
}
