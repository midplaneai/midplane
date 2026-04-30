// Region → public-facing host + Fly app name. Adding iad in V1 launch is
// a one-line change here plus a fly-iad.toml; no schema migration needed.

import type { Region } from "@midplane-cloud/kms";

export interface RegionConfig {
  publicHost: string; // <region>.midplane.com
  flyApp: string; // midplane-fra | midplane-iad
}

export function loadRegions(env: NodeJS.ProcessEnv): Record<Region, RegionConfig> {
  return {
    fra: {
      publicHost: env.MIDPLANE_PUBLIC_HOST_FRA ?? "localhost:3000",
      flyApp: env.FLY_APP_FRA ?? "midplane-fra",
    },
    iad: {
      publicHost: env.MIDPLANE_PUBLIC_HOST_IAD ?? "localhost:3000",
      flyApp: env.FLY_APP_IAD ?? "midplane-iad",
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
