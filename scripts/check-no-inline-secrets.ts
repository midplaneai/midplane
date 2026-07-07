#!/usr/bin/env bun
// CI guard: no secret-bearing value on a docker/shell command line via inline `-e`.
//
// The docs promise (SELF_HOST.md, engine/README.md, the docs site) is that a DSN
// or password never rides on a command line — you set it in an env file the
// process reads. Inline `-e DATABASE_URL=…` leaks the credential to `ps aux` and
// shell history, so a runnable snippet that does it makes the promise false and
// teaches readers the wrong pattern (they copy snippets). This scans tracked
// docs/config/shell files and fails on any inline `-e <SECRET_VAR>=` in a command.
//
// Every command form docker accepts is covered (see FLAG_RE): `-e VAR=`,
// `--env VAR=`, the equals-joined `-e=VAR=` / `--env=VAR=`, the attached
// `-eVAR=`, and shell-quoted `-e 'VAR=…'` / `-e "VAR=…"`.
//
// Warning prose that names the anti-pattern is fine — but reword it so the literal
// `-e <VAR>=` doesn't appear at all (a backtick-wrapped `-e` with no `VAR=` after
// it is not a command and is not matched), rather than relying on the allowlist.
//
//   bun scripts/check-no-inline-secrets.ts

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

// A var name is secret-bearing if it carries a DSN, password, key, pepper, or
// token. Matches the classes called out in the docs promise: DATABASE_URL,
// *_SECRET, *_KEY*, *_PEPPER*, POSTGRES_PASSWORD (and DSN/TOKEN for good measure).
const SECRET_VAR = /(SECRET|PASSWORD|PEPPER|KEY|TOKEN|DATABASE_URL|DSN)/;

// The command shape we forbid: a `-e` / `--env` flag then a VAR then `=`, in any
// form docker accepts for putting the value on the command line:
//   -e VAR=…     --env VAR=…      (space-separated)
//   -e=VAR=…     --env=VAR=…      (equals-joined)
//   -eVAR=…                       (attached short flag — pflag shorthand)
//   -e 'VAR=…'   -e "VAR=…"       (shell-quoted value)
// The separator is `=` or whitespace or nothing; an optional quote may sit before
// the VAR. The leading `(^|\s)` anchor is what keeps this from matching `-e`
// inside `--env-file` or a backtick-wrapped `-e` mention in warning prose (the
// char before `-e` there is `-` or a backtick, not whitespace/line-start).
const FLAG_RE = /(?:^|\s)(?:-e|--env)(?:=|\s+)?(?:['"])?([A-Za-z_][A-Za-z0-9_]*)=/g;

// Paths scanned by extension below would also sweep legitimate ephemeral CI
// harnesses. These run against throwaway containers with generated test
// passwords and are torn down at teardown — nothing a reader copies to prod.
const ALLOWLIST_PATHS = new Set([
  // Boots a sidecar Postgres + the engine image with a disposable test password
  // (PG_PASSWORD defaults to `midplane_test`) and `docker rm`s both at cleanup.
  "engine/scripts/lib/image-boot.sh",
]);

// Which tracked files carry runnable commands: docs, CI/compose YAML, and shell.
// (Env-file examples like .env*.example are `KEY=VALUE`, not commands, and carry
// no `-e` flag, so they're out of scope.)
function isScanned(path: string): boolean {
  if (ALLOWLIST_PATHS.has(path)) return false;
  if (/\.(md|ya?ml|sh)$/.test(path)) return true;
  return path.startsWith("bin/"); // bin/self-host and friends have no extension
}

export interface Hit {
  path: string;
  line: number;
  variable: string;
  context: string;
}

// Pure, unit-testable: every inline `-e <SECRET_VAR>=` occurrence in `text`.
export function scanForInlineSecrets(path: string, text: string): Hit[] {
  const out: Hit[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    FLAG_RE.lastIndex = 0;
    for (const m of line.matchAll(FLAG_RE)) {
      const variable = m[1]!;
      if (SECRET_VAR.test(variable)) {
        out.push({ path, line: i + 1, variable, context: line.trim() });
      }
    }
  }
  return out;
}

function trackedFiles(root: string): string[] {
  // Tracked files only (honors .gitignore, so node_modules / .next are skipped),
  // matching how check-connection-rename.sh scopes to git-tracked content.
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean);
}

function main(): void {
  const root = join(import.meta.dir, "..");
  const hits: Hit[] = [];
  for (const path of trackedFiles(root)) {
    if (!isScanned(path)) continue;
    let text: string;
    try {
      text = readFileSync(join(root, path), "utf8");
    } catch {
      continue;
    }
    hits.push(...scanForInlineSecrets(path, text));
  }

  if (hits.length > 0) {
    console.error(
      `[check-no-inline-secrets] FAILED: ${hits.length} inline-secret command(s) ` +
        `found. A DSN/password must be set in an env file (--env-file), never on ` +
        `the command line (it leaks to ps/history):`,
    );
    for (const h of hits) {
      console.error(`  ${h.path}:${h.line}: -e ${h.variable}=…  (${h.context})`);
    }
    console.error(
      `Fix: move the value into the env file the process reads. If this is a ` +
        `genuine throwaway CI harness, add the path to ALLOWLIST_PATHS with a reason.`,
    );
    process.exit(1);
  }
  console.log("[check-no-inline-secrets] OK: no inline -e <secret>= commands.");
}

if (import.meta.main) main();
