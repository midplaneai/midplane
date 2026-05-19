import { Badge } from "@/components/ui/badge";
import type { Region } from "@midplane-cloud/kms";

const LONG_LABEL: Record<Region, string> = {
  eu: "European Union",
  us: "United States",
};

// Topbar badge surfacing the customer's residency region. Display-only in
// V1 — no link, no menu (a /residency page comes in V1.5). The aria-label
// reads "Your data is hosted in <region>" so screen readers carry the
// trust signal alongside the visual one.
export function RegionBadge({ region }: { region: Region }) {
  const variant = region === "eu" ? "region-eu" : "region-us";
  return (
    <Badge
      variant={variant}
      aria-label={`Your data is hosted in ${LONG_LABEL[region]}`}
    >
      {region.toUpperCase()}
    </Badge>
  );
}
