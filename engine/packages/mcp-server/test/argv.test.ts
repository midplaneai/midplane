// argv.ts — direct unit tests for the shared hand-rolled parser. Four
// subcommands (query/doctor/init/policy) ride on these exact semantics; a
// regression here changes flag parsing for all of them at once.

import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/argv.ts";

describe("parseArgs", () => {
  test("--key value consumes the next token", () => {
    expect(parseArgs(["--sql", "SELECT 1"]).flags.sql).toBe("SELECT 1");
  });

  test("--key=value form", () => {
    const { flags } = parseArgs(["--sql=SELECT 1", "--limit=5"]);
    expect(flags.sql).toBe("SELECT 1");
    expect(flags.limit).toBe("5");
  });

  test("bare flag becomes \"true\"; --no- prefix becomes \"false\"", () => {
    const { flags } = parseArgs(["--json", "--no-canary"]);
    expect(flags.json).toBe("true");
    expect(flags.canary).toBe("false");
  });

  test("a flag followed by another flag stays boolean", () => {
    const { flags } = parseArgs(["--json", "--db", "main"]);
    expect(flags.json).toBe("true");
    expect(flags.db).toBe("main");
  });

  test("a flag followed by a -short token stays boolean", () => {
    const { flags } = parseArgs(["--flag", "-o", "out.yaml"]);
    expect(flags.flag).toBe("true");
    expect(flags.o).toBe("out.yaml");
  });

  test("-o without a following value becomes \"true\"", () => {
    expect(parseArgs(["-o"]).flags.o).toBe("true");
    expect(parseArgs(["-o", "--json"]).flags.o).toBe("true");
  });

  test("positionals and flags split in one pass — flag values never leak", () => {
    const { positionals, flags } = parseArgs(["file.yaml", "--sql", "SELECT 1", "extra"]);
    expect(positionals).toEqual(["file.yaml", "extra"]);
    expect(flags.sql).toBe("SELECT 1");
  });

  test("empty argv", () => {
    expect(parseArgs([])).toEqual({ positionals: [], flags: {} });
  });

  // Regression (Codex P2): boolean flags must never swallow a positional —
  // `policy test --json policy.yaml` has to keep policy.yaml as the <file>.
  test("boolean flags never consume the next positional", () => {
    const { positionals, flags } = parseArgs(["--json", "policy.yaml", "--sql", "SELECT 1"]);
    expect(flags.json).toBe("true");
    expect(positionals).toEqual(["policy.yaml"]);
    expect(flags.sql).toBe("SELECT 1");

    const pretty = parseArgs(["--pretty", "Q1"]);
    expect(pretty.flags.pretty).toBe("true");
    expect(pretty.positionals).toEqual(["Q1"]);
  });

  test("--server still takes its optional value", () => {
    expect(parseArgs(["--server", "http://h:1"]).flags.server).toBe("http://h:1");
    expect(parseArgs(["--server", "--sql", "x"]).flags.server).toBe("true");
  });
});
