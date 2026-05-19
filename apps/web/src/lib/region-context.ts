import { AsyncLocalStorage } from "node:async_hooks";

import type { Region } from "@midplane-cloud/kms";

// Request-scope region context. The Next.js middleware reads
// auth().sessionClaims.org?.publicMetadata?.region and wraps the rest of
// the request in `withRegion()`. Server actions, route handlers, and any
// lib code that calls `getDb()` reads back from `currentRegion()`.
//
// Two patterns coexist:
//
//   - Request-scope callers: read region from ALS via `currentRegion()`.
//     Throws if called outside a request — that surfaces "middleware did
//     not run for this path" bugs loudly, instead of silently picking a
//     default region.
//
//   - Module-init / boot-time callers: read region from process env via
//     `bootRegion()`. Specifically `apps/web/src/lib/mcp-proxy.ts:83` —
//     the proxy context is constructed once on first import, before any
//     request scope exists, so it can't reach into ALS.

const store = new AsyncLocalStorage<Region>();

export function withRegion<T>(region: Region, fn: () => T): T {
  return store.run(region, fn);
}

export function currentRegion(): Region {
  const r = store.getStore();
  if (!r) {
    throw new Error(
      "region context not set — middleware did not run for this request",
    );
  }
  return r;
}

export function bootRegion(): Region {
  const r = process.env.MIDPLANE_REGION;
  if (r !== "eu" && r !== "us") {
    throw new Error(
      `MIDPLANE_REGION must be "eu" or "us"; got ${JSON.stringify(r)}`,
    );
  }
  return r;
}
