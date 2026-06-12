// Hand-rolled argv parsing shared by the query/doctor/init/policy
// subcommands (no commander/yargs — the data plane's dependency tree is part
// of the security story). audit-cli keeps its older flags-only parser for
// back-compat with its documented flag forms; porting it here is a known
// cleanup.
//
// Positionals and flags are split in a SINGLE pass, so a flag VALUE
// (`--sql "SELECT ..."`) is never mistaken for a positional, regardless of
// flag order. Supports `--key value`, `--key=value`, `--flag` (→ "true"),
// `--no-flag` (→ "false"), and the `-o value` short alias.

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string>;
}

// Flags that never take a value, so they never swallow the next positional:
// `policy test --json policy.yaml` must keep policy.yaml as the <file>.
// (`--server` is deliberately NOT here — it takes an optional URL value.)
const BOOLEAN_FLAGS = new Set(["json", "pretty", "help", "stdio", "canary", "allow-http"]);

export function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-o") {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags.o = next;
        i++;
      } else {
        flags.o = "true";
      }
      continue;
    }
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    if (a.startsWith("--no-")) {
      flags[a.slice(5)] = "false";
      continue;
    }
    const eq = a.indexOf("=");
    if (eq >= 0) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = args[i + 1];
    if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith("-")) {
      // Consumes the next token as this flag's value, so it won't be read as a
      // positional. (`--flag --other` and `--flag -o x` leave `--flag` boolean.)
      flags[key] = next;
      i++;
    } else {
      flags[key] = "true";
    }
  }
  return { positionals, flags };
}
