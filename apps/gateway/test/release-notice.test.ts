// What a linked gateway logs of the releases a sync answer names: a newer
// release, and an upgrade needed, each once per version above any said
// before, and nothing for a gateway that is current or isn't a release.

import type { SyncRelease } from "@midplane/protocol";
import { describe, expect, it } from "vitest";
import {
  type ReleaseNotice,
  releaseNotices,
  type Said,
} from "../src/release-notice.ts";

/**
 * A gateway at `version` hearing each answer's `release` in turn, recording
 * what it said as the link client does; the lines, per answer.
 */
function syncs(
  version: string,
  answers: (SyncRelease | undefined)[],
): ReleaseNotice[][] {
  const said: Said = { latest: null, needed: null };
  return answers.map((release) => {
    const lines = releaseNotices(version, release, said);
    for (const line of lines) {
      if (line.level === "info") said.latest = line.latest;
      else said.needed = line.needed;
    }
    return lines;
  });
}

const newer = (version: string, latest: string): ReleaseNotice => ({
  level: "info",
  msg: "newer midplane available",
  version,
  latest,
});

describe("release notices", () => {
  // protects=#85 criterion 1: one line per new version: a gateway at 0.22.0 told latest 0.24.0 on 3 syncs says so once, then once more for 0.25.0, and not again for either, nor for 0.24.0 after 0.25.0;
  // fails_when=it repeats each sync, stays quiet about a second newer release, or says an older one after a newer;
  // no_claim=a real cloud, or the link client keeping what it said (link.e2e.test.ts)
  it("says a newer release is out once for each version", () => {
    const r = (latest: string) => ({ latest });
    expect(
      syncs("0.22.0", [
        r("0.24.0"),
        r("0.24.0"),
        r("0.24.0"),
        r("0.25.0"),
        r("0.25.0"),
        undefined,
        r("0.24.0"),
      ]),
    ).toEqual([
      [newer("0.22.0", "0.24.0")],
      [],
      [],
      [newer("0.22.0", "0.25.0")],
      [],
      [],
      [],
    ]);
  });

  // protects=#85 criterion 2: none when current: a gateway at 0.24.0 told latest 0.24.0 or 0.23.0 says nothing;
  // fails_when=it tells a current gateway, or one newer than the cloud knows, to upgrade;
  // no_claim=which release is newest (the cloud's to say)
  it("says nothing to a gateway at or past the newest", () => {
    expect(
      syncs("0.24.0", [{ latest: "0.24.0" }, { latest: "0.23.0" }]),
    ).toEqual([[], []]);
  });

  // protects=#85 criterion 3: with needed 0.24.1, a gateway at 0.24.0 logs one warn line `midplane upgrade needed` with the reason, and the advisory when given; at 0.24.1, none; a raised floor is said once more, a lowered one not;
  // fails_when=the warning repeats each sync, is said at or above the floor, loses its reason, or invents an advisory;
  // no_claim=what a person does about it
  it("warns once for each lowest version, below it only", () => {
    const needed = (version: string, advisory?: string): SyncRelease => ({
      latest: "0.24.1",
      needed: { version, reason: "r", ...(advisory ? { advisory } : {}) },
    });
    const warn = (needed: string, advisory?: string): ReleaseNotice => ({
      level: "warn",
      msg: "midplane upgrade needed",
      version: "0.24.0",
      needed,
      reason: "r",
      ...(advisory ? { advisory } : {}),
    });
    const advisory = "https://github.com/midplaneai/midplane/releases";
    expect(
      syncs("0.24.0", [
        needed("0.24.1"),
        needed("0.24.1"),
        needed("0.24.2", advisory),
        needed("0.24.1"),
      ]),
    ).toEqual([
      [newer("0.24.0", "0.24.1"), warn("0.24.1")],
      [],
      [warn("0.24.2", advisory)],
      [],
    ]);
    expect(syncs("0.24.1", [needed("0.24.1"), needed("0.24.0")])).toEqual([
      [],
      [],
    ]);
  });

  // protects=#85: neither line appears if either version doesn't parse: a dev build, a release candidate, or a version the cloud sends with a `v`;
  // fails_when=a dev build is told to upgrade, or a malformed version throws or is said;
  // no_claim=versions the protocol refuses (packages/protocol/test/link.test.ts)
  it("says nothing unless both versions are releases", () => {
    const release = {
      latest: "0.25.0",
      needed: { version: "0.25.0", reason: "r" },
    };
    for (const version of ["dev", "0.25.0-rc.1", "v0.22.0"]) {
      expect(syncs(version, [release]), version).toEqual([[]]);
    }
    expect(
      syncs("0.22.0", [
        { latest: "v0.25.0", needed: { version: "0.25.0-rc.1", reason: "r" } },
      ]),
    ).toEqual([[]]);
    // Each line checks its own: a malformed latest still lets the warning through.
    expect(
      syncs("0.22.0", [
        { latest: "latest", needed: { version: "0.24.1", reason: "r" } },
      ]),
    ).toEqual([
      [
        {
          level: "warn",
          msg: "midplane upgrade needed",
          version: "0.22.0",
          needed: "0.24.1",
          reason: "r",
        },
      ],
    ]);
  });
});
