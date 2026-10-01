// Dependency rules that live in package manifests and tsconfigs, where the
// linter can't see them. Source-level rules (forbidden imports and globals)
// live in biome.json; test/boundaries.test.ts proves both layers bite.
//
//   node scripts/check-boundaries.ts <workspace-root> [--allow-link-root <dir>]...

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/**
 * The only runtime dependencies each pure package may declare. Adding one is a
 * deliberate edit here plus an entry in DECISIONS.md.
 */
export const PURE_PACKAGES: Readonly<Record<string, readonly string[]>> = {
  "@midplane/core": [
    "@midplane/protocol",
    "libpg-query",
    "pgsql-deparser",
    "@pgsql/types",
    "@noble/hashes",
  ],
  "@midplane/protocol": ["zod"],
};

/** Package names of the old tree, which v2 copies from but never depends on. */
const OLD_TREE = [/^@midplane-cloud\//, /^@midplane\/engine$/];

const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;
const RUNTIME_DEP_FIELDS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export type Manifest = {
  name?: string;
  /** Set on a package that is published to npm. */
  publishConfig?: Record<string, unknown>;
} & Partial<Record<(typeof DEP_FIELDS)[number], Record<string, string>>>;

export type TsConfig = {
  compilerOptions?: { types?: string[]; lib?: string[] };
};

export type Options = {
  /** Workspace root; path dependencies must stay inside it. */
  root: string;
  /** Extra directories path dependencies may point into (cloud → oss). */
  allowLinkRoots: string[];
};

function isInside(dir: string, parent: string): boolean {
  const rel = relative(parent, dir);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

/** Violations in one package manifest living in `dir`. */
export function checkManifest(
  manifest: Manifest,
  dir: string,
  options: Options,
): string[] {
  const where = manifest.name ?? dir;
  const errors: string[] = [];

  for (const field of DEP_FIELDS) {
    for (const [dep, spec] of Object.entries(manifest[field] ?? {})) {
      if (OLD_TREE.some((pattern) => pattern.test(dep))) {
        errors.push(`${where}: ${field} names the old tree (${dep})`);
      }
      const path = /^(?:link|file|portal):(.+)$/.exec(spec)?.[1];
      if (path !== undefined) {
        const target = resolve(dir, path);
        const allowed = [options.root, ...options.allowLinkRoots];
        if (!allowed.some((root) => isInside(target, resolve(root)))) {
          errors.push(
            `${where}: ${field}.${dep} points outside the workspace (${spec})`,
          );
        }
      }
    }
  }

  const allowlist = manifest.name ? PURE_PACKAGES[manifest.name] : undefined;
  if (allowlist) {
    for (const field of RUNTIME_DEP_FIELDS) {
      for (const dep of Object.keys(manifest[field] ?? {})) {
        if (!allowlist.includes(dep)) {
          errors.push(
            `${where}: is pure and may not depend on ${dep} (${field}); allowed: ${allowlist.join(", ")}`,
          );
        }
      }
    }
  }

  return errors;
}

/**
 * A package published to npm bundles the pure packages it uses, so it may
 * not depend on any workspace package at runtime, and every third-party
 * runtime dependency of a pure package it bundles must be its own, at the
 * same version, or the installed bundle would run against another one.
 */
export function checkPublished(
  manifest: Manifest,
  byName: ReadonlyMap<string, Manifest>,
): string[] {
  if (!manifest.publishConfig) return [];
  const where = manifest.name ?? "(published package)";
  const errors: string[] = [];
  const own = manifest.dependencies ?? {};
  for (const field of RUNTIME_DEP_FIELDS) {
    for (const [dep, spec] of Object.entries(manifest[field] ?? {})) {
      if (spec.startsWith("workspace:")) {
        errors.push(
          `${where}: is published, so ${dep} must be bundled (a devDependency), not a runtime ${field}`,
        );
      }
    }
  }
  const bundled = new Set<string>();
  const visit = (name: string) => {
    if (bundled.has(name) || !PURE_PACKAGES[name]) return;
    bundled.add(name);
    const pure = byName.get(name);
    for (const [dep, spec] of Object.entries(pure?.dependencies ?? {})) {
      if (spec.startsWith("workspace:")) visit(dep);
      else if (own[dep] !== spec) {
        errors.push(
          `${where}: bundles ${name}, so it must depend on ${dep} ${spec} (has ${own[dep] ?? "none"})`,
        );
      }
    }
  };
  for (const dep of Object.keys(manifest.devDependencies ?? {})) visit(dep);
  return errors;
}

/**
 * A pure package's tsconfig may not widen the base's ambient types or lib:
 * with `types: []` and an ES-only lib, `process`, `fetch` and friends don't
 * typecheck, which backs up the lint rules.
 */
export function checkPureTsConfig(
  name: string,
  tsconfig: TsConfig,
  base: TsConfig,
): string[] {
  const errors: string[] = [];
  const own = tsconfig.compilerOptions ?? {};
  if (own.types !== undefined || own.lib !== undefined) {
    errors.push(`${name}: tsconfig may not set "types" or "lib"`);
  }
  const types = base.compilerOptions?.types;
  if (!Array.isArray(types) || types.length > 0) {
    errors.push(`${name}: base tsconfig must set "types": []`);
  }
  const lib = base.compilerOptions?.lib ?? [];
  if (lib.some((entry) => /^(dom|webworker)/i.test(entry))) {
    errors.push(`${name}: base tsconfig lib may not include DOM or WebWorker`);
  }
  return errors;
}

function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    throw new Error(`cannot read ${path}: ${(error as Error).message}`);
  }
}

/** Directories holding a package.json: the root and up to two levels below. */
function packageDirs(root: string): string[] {
  const dirs = [root];
  const visit = (dir: string, depth: number): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue;
      if (entry.name.startsWith(".") || entry.name === "dist") continue;
      const child = join(dir, entry.name);
      if (existsSync(join(child, "package.json"))) dirs.push(child);
      if (depth < 2) visit(child, depth + 1);
    }
  };
  visit(root, 1);
  return dirs;
}

export function checkWorkspace(options: Options): string[] {
  const errors: string[] = [];
  const manifests = packageDirs(options.root).map(
    (dir) => [dir, readJson<Manifest>(join(dir, "package.json"))] as const,
  );
  const byName = new Map(
    manifests.flatMap(([, m]) => (m.name ? [[m.name, m] as const] : [])),
  );
  for (const [dir, manifest] of manifests) {
    errors.push(...checkManifest(manifest, dir, options));
    errors.push(...checkPublished(manifest, byName));
    if (manifest.name && PURE_PACKAGES[manifest.name]) {
      const tsconfig = readJson<TsConfig>(join(dir, "tsconfig.json"));
      const base = readJson<TsConfig>(join(options.root, "tsconfig.base.json"));
      errors.push(...checkPureTsConfig(manifest.name, tsconfig, base));
    }
  }
  return errors;
}

function parseArgs(args: string[]): Options {
  const [root, ...rest] = args;
  if (!root) throw new Error("usage: check-boundaries <workspace-root>");
  const allowLinkRoots: string[] = [];
  for (let i = 0; i < rest.length; i += 2) {
    const value = rest[i + 1];
    if (rest[i] !== "--allow-link-root" || !value) {
      throw new Error(`unexpected argument: ${rest[i]}`);
    }
    allowLinkRoots.push(resolve(value));
  }
  return { root: resolve(root), allowLinkRoots };
}

if (import.meta.main) {
  const errors = checkWorkspace(parseArgs(process.argv.slice(2)));
  if (errors.length > 0) {
    for (const error of errors) console.error(`✗ ${error}`);
    process.exit(1);
  }
  console.log("✓ package boundaries hold");
}
