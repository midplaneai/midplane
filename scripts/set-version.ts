// Sets the gateway's version everywhere a release reads it: the package, its
// MCP registry entry, the deploy templates' image pins and the Dockerfile's
// example. The docs' marks for behaviour no release has yet, (`unreleased`),
// become (`X.Y.Z+`). The monorepo's release train runs it for the weekly bump
// pull request; run it by hand for a release out of turn.
//
//   node scripts/set-version.ts <X.Y.Z>

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..");

/** Each file that pins the version, and how many times it names it. */
const PINS: Readonly<Record<string, number>> = {
  "apps/gateway/package.json": 1,
  "apps/gateway/server.json": 2,
  Dockerfile: 1,
  "deploy/aws/midplane-gateway.yaml": 3,
  "deploy/helm/midplane-gateway/Chart.yaml": 2,
  "deploy/render/render.yaml": 1,
};

const UNRELEASED = "`unreleased`";

const parts = (v: string): number[] | undefined =>
  /^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : undefined;

/** Whether version a comes after b. */
const newer = (a: number[], b: number[]): boolean => {
  const i = a.findIndex((n, k) => n !== b[k]);
  return i !== -1 && (a[i] ?? 0) > (b[i] ?? 0);
};

const next = process.argv[2] ?? "";
const to = parts(next);
if (!to) {
  console.error("usage: node scripts/set-version.ts <X.Y.Z>");
  process.exit(1);
}
const current = JSON.parse(
  readFileSync(join(root, "apps/gateway/package.json"), "utf8"),
).version as string;
const from = parts(current);
if (!from || !newer(to, from)) {
  console.error(`${next} isn't newer than the current version, ${current}`);
  process.exit(1);
}

// The current version as a whole version, not inside 10.26.1 or 0.26.10.
const pin = new RegExp(
  `(?<![\\d.])${current.replaceAll(".", "\\.")}(?![\\d.]*\\d)`,
  "g",
);

// Every file is checked before any is written, so a count that doesn't match
// leaves the tree as it was.
const edits = Object.entries(PINS).map(([file, count]) => {
  const text = readFileSync(join(root, file), "utf8");
  const found = text.match(pin)?.length ?? 0;
  if (found !== count) {
    console.error(
      `${file} names ${current} ${found} times, not ${count}: update PINS in scripts/set-version.ts`,
    );
    process.exit(1);
  }
  return [file, text.replace(pin, next)] as const;
});
for (const [file, text] of edits) writeFileSync(join(root, file), text);
console.log(`${current} -> ${next} in ${edits.length} files`);

const docs = join(root, "docs");
for (const entry of readdirSync(docs, { recursive: true })) {
  const file = join(docs, String(entry));
  if (!file.endsWith(".mdx")) continue;
  const text = readFileSync(file, "utf8");
  const marks = text.split(UNRELEASED).length - 1;
  if (marks === 0) continue;
  writeFileSync(file, text.replaceAll(UNRELEASED, `\`${next}+\``));
  console.log(
    `${relative(root, file)}: ${marks} (\`unreleased\`) marked ${next}+`,
  );
}
