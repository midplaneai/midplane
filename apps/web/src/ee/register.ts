import { registerEeAuthPlugins } from "@/lib/ee-plugins";

import { eeEnabled } from "./index";
import { buildSsoPlugins } from "./sso";

// Enterprise Edition boot hook. The single entry point that wires ee features
// into core, called once at server boot by instrumentation.ts (the cloud-only
// entrypoint, outside src/) via a flag-guarded dynamic import. ee MAY import
// core (the registry); core never imports ee — so this file, and everything it
// pulls in, vanishes cleanly when ee/ is deleted for an MIT build.
//
// Self-gated on eeEnabled() so even if some non-cloud path reached it, a build
// without the Enterprise flag registers nothing and the ee surface stays dark.

export function registerEe(): void {
  if (!eeEnabled()) return;
  registerEeAuthPlugins(buildSsoPlugins());
}
