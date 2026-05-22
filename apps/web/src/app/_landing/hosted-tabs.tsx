"use client";

// Tabbed Hosted vs Self-host. The section's whole point is "pick one" —
// showing both side-by-side on mobile cost two cards' worth of scroll
// for content the reader only needs half of. The original .parity
// 2-up grid is preserved as the tab panel layout so the visual rhythm
// of the page is unchanged on desktop.
//
// Hosted is the default tab (it's the recommendation; self-host is the
// "you have a special reason" path).

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";

const tabsListClass = "border-b-[var(--line)] gap-0";
const triggerClass = [
  "px-5 py-3 text-[13px] font-medium",
  "text-[var(--ink-3)]",
  "hover:text-[var(--ink-2)]",
  "data-[state=active]:text-[var(--ink)]",
  "data-[state=active]:after:bg-[var(--ink)]",
  "data-[state=active]:after:h-[2px]",
].join(" ");

export function HostedTabs() {
  return (
    <Tabs defaultValue="hosted" className="parity-tabs">
      <TabsList className={tabsListClass}>
        <TabsTrigger value="hosted" className={triggerClass}>
          Hosted{" "}
          <span className="ml-2 text-[var(--ink-4)] text-[11px]">EU + US</span>
        </TabsTrigger>
        <TabsTrigger value="self-host" className={triggerClass}>
          Self-host{" "}
          <span className="ml-2 text-[var(--ink-4)] text-[11px]">MIT</span>
        </TabsTrigger>
      </TabsList>

      <TabsContent value="hosted" className="pt-6">
        <div className="parity-panel">
          <h3>We host it.</h3>
          <p>
            Sign up, paste your DSNs, drop the MCP URL into your agent.
            You get back hours of platform work.
          </p>
          <ul className="cloud-list">
            <li>
              <span className="mk">✓</span>
              <span>
                <b>Isolation managed</b> — region pinning, per-workspace KMS,
                scoped connection pools.
              </span>
            </li>
            <li>
              <span className="mk">✓</span>
              <span>
                <b>Audit storage included</b> — 7 / 30 / 180-day retention by
                tier. Append-only, queryable from the dashboard.
              </span>
            </li>
            <li>
              <span className="mk">✓</span>
              <span>
                <b>Free forever</b> — 1 connection, 1 seat, 7-day audit
                retention. No credit card. Query volume is not metered.
              </span>
            </li>
          </ul>
          <span className="image-tag mono">
            fly · <b>eu + us</b>
          </span>
          <div className="footnote">
            <span>setup &lt; 60s</span>
            <span>v0.5.0</span>
          </div>
        </div>
      </TabsContent>

      <TabsContent value="self-host" className="pt-6">
        <div className="parity-panel">
          <h3>You host it.</h3>
          <p>
            Run the same container in your own infrastructure. Common
            reasons: on-prem requirement, air-gapped network, existing
            Postgres platform you want to extend.
          </p>
          <ul className="host-list">
            <li>
              <span className="mk">○</span>
              <span>
                You handle patching, upgrades, audit storage, HA, and
                region routing.
              </span>
            </li>
            <li>
              <span className="mk">○</span>
              <span>
                Open source, MIT licensed. Same engine, same policy
                format, same audit shape as the hosted plane.
              </span>
            </li>
          </ul>
          <span className="image-tag mono">
            github · <b>midplaneai/midplane</b>
          </span>
          <div className="footnote">
            <span>docker pull midplane/midplane:0.6.0</span>
            <span>install &lt; 30s</span>
          </div>
        </div>
      </TabsContent>
    </Tabs>
  );
}
