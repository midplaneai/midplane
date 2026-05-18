// Region → public-facing host + Fly app name. Adding us in V1 launch is
// a one-line change here plus a fly-us.toml; no schema migration needed.

import type { Region } from "@midplane-cloud/kms";

export interface RegionConfig {
  publicHost: string; // <region>.midplane.com
  flyApp: string; // midplane-eu | midplane-us
  // Fly Machines API region code (airport-code, e.g. "fra"/"iad"). Required
  // when creating a machine — Fly rejects our jurisdiction codes. Configurable
  // because the same EU jurisdiction may later route to ams instead of fra.
  flyRegion: string;
}

export function loadRegions(env: NodeJS.ProcessEnv): Record<Region, RegionConfig> {
  return {
    eu: {
      publicHost: env.MIDPLANE_PUBLIC_HOST_EU ?? "localhost:3000",
      flyApp: env.FLY_APP_EU ?? "midplane-eu",
      flyRegion: env.FLY_REGION_EU ?? "fra",
    },
    us: {
      publicHost: env.MIDPLANE_PUBLIC_HOST_US ?? "localhost:3000",
      flyApp: env.FLY_APP_US ?? "midplane-us",
      flyRegion: env.FLY_REGION_US ?? "iad",
    },
  };
}

export function mintMcpUrl(region: Region, token: string, env: NodeJS.ProcessEnv): string {
  const host = loadRegions(env)[region].publicHost;
  // Hosted shape: https://<region>.midplane.com/mcp/<token>. In dev the
  // default host is localhost:3000 (Next.js handles /mcp/<token> directly
  // until the Fly proxy lands).
  const scheme = host.startsWith("localhost") || host.endsWith(".local") ? "http" : "https";
  return `${scheme}://${host}/mcp/${token}`;
}
