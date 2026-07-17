// Unit coverage for the help-link source of truth shared by the desktop
// sidebar (app-shell.tsx) and the mobile bar (mobile-nav.tsx): Docs on every
// build, then the cloud support mailbox — or GitHub issues on self-host,
// where a cloud mailbox that can't see the instance would be the wrong door.

import { describe, expect, it } from "vitest";

import { helpLinksFor } from "../src/components/layout/help-links.ts";
import { DOCS_HOME_URL } from "../src/lib/docs.ts";
import { GITHUB_ISSUES_URL } from "../src/lib/support.ts";

describe("helpLinksFor", () => {
  it("cloud: Docs (new tab) + the support mailbox (in-tab mailto)", () => {
    const links = helpLinksFor({ selfHost: false });
    expect(links.map((l) => l.label)).toEqual(["Docs", "Email support"]);
    expect(links[0]).toMatchObject({ href: DOCS_HOME_URL, newTab: true });
    expect(links[1]?.href).toBe(
      "mailto:support@midplane.ai?subject=Midplane%20support",
    );
    // A mailto must not target a new tab — that leaves a blank window behind.
    expect(links[1]?.newTab).toBe(false);
  });

  it("self-host: GitHub issues replaces the cloud mailbox", () => {
    const links = helpLinksFor({ selfHost: true });
    expect(links.map((l) => l.label)).toEqual(["Docs", "GitHub issues"]);
    expect(links[1]).toMatchObject({ href: GITHUB_ISSUES_URL, newTab: true });
    expect(links.some((l) => l.href.startsWith("mailto:"))).toBe(false);
  });
});
