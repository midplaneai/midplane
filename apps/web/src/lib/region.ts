import type { Region } from "@midplane-cloud/kms";

// EU country codes Midplane treats as fra-region by default. Anything else
// falls through to iad. The picker is the source of truth — this is only
// the IP-autodetected default.
const EU_COUNTRIES = new Set([
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR",
  "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO",
  "SE", "SI", "SK",
  // EFTA + UK rolled in by latency, not legal residency
  "GB", "CH", "NO", "IS", "LI",
]);

export function defaultRegionForCountry(
  countryCode: string | null | undefined,
): Region {
  if (countryCode && EU_COUNTRIES.has(countryCode.toUpperCase())) return "fra";
  return "iad";
}

export const REGION_LABELS: Record<Region, string> = {
  fra: "Europe (Frankfurt)",
  iad: "United States (Ohio)",
};
