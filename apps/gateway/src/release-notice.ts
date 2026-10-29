// What a linked gateway logs of the releases Midplane Cloud names in its
// sync answer: that a newer one is out, and that an upgrade is needed, each
// once per version above any said before. It only logs: nothing here
// fetches, installs or changes anything. Only release versions compare, so
// a `dev` build, a release candidate or a malformed version says nothing.

import {
  compareVersions,
  parseVersion,
  type SyncRelease,
} from "@midplane/protocol";

export type ReleaseNotice =
  | {
      level: "info";
      msg: "newer midplane available";
      version: string;
      latest: string;
    }
  | {
      level: "warn";
      msg: "midplane upgrade needed";
      version: string;
      needed: string;
      reason: string;
      advisory?: string;
    };

/**
 * The highest versions logged in this process, so each is said once: one
 * version each, however many the answers name.
 */
export interface Said {
  latest: string | null;
  needed: string | null;
}

/** Whether `version` is a release below `than`, which is one too. */
const below = (version: string, than: string) =>
  parseVersion(version) !== null &&
  parseVersion(than) !== null &&
  compareVersions(version, than) < 0;

/** Whether `version` is above the highest said, or none was. */
const unsaid = (version: string, said: string | null) =>
  said === null || below(said, version);

/** The lines a gateway at `version` logs for this answer's `release`. */
export function releaseNotices(
  version: string,
  release: SyncRelease | undefined,
  said: Said,
): ReleaseNotice[] {
  if (!release) return [];
  const lines: ReleaseNotice[] = [];
  const { latest, needed } = release;
  if (below(version, latest) && unsaid(latest, said.latest)) {
    lines.push({
      level: "info",
      msg: "newer midplane available",
      version,
      latest,
    });
  }
  if (
    needed &&
    below(version, needed.version) &&
    unsaid(needed.version, said.needed)
  ) {
    lines.push({
      level: "warn",
      msg: "midplane upgrade needed",
      version,
      needed: needed.version,
      reason: needed.reason,
      ...(needed.advisory ? { advisory: needed.advisory } : {}),
    });
  }
  return lines;
}
