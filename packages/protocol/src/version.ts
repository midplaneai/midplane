// Gateway versions as releases name them: `X.Y.Z`, numbers only. The cloud
// compares a gateway's reported version with the newest release, and the
// gateway compares its own with what the cloud says. Anything else (`dev`,
// a release candidate, a `v` in front) isn't a release and never compares.

const RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** "0.24.0" as numbers; null for anything else ("dev", "0.25.0-rc.1", "v0.24.0"). */
export function parseVersion(
  v: string,
): readonly [number, number, number] | null {
  const m = RELEASE.exec(v);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3])] as const;
  return parts.every(Number.isSafeInteger) ? parts : null;
}

/** <0, 0, >0; both must parse. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) {
    throw new Error(`not a release version: ${x ? b : a}`);
  }
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
