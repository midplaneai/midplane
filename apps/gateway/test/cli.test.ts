// The command line without a database: `--help` prints the usage, a flag a
// command doesn't know prints it too, and `token --ttl` takes whole seconds.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeJwt } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const run = (args: string[]) => {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, NOTES_DSN: "postgres://agent@127.0.0.1:1/notes" },
  });
  return { status: r.status, out: String(r.stdout), err: String(r.stderr) };
};

// Each case loads the gateway, and a shared runner can take a second apiece.
describe("midplane command line", { timeout: 30_000 }, () => {
  let token: (ttl: string) => ReturnType<typeof run>;

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "midplane-cli-"));
    execFileSync(process.execPath, [CLI, "keygen", "--out", dir]);
    writeFileSync(
      join(dir, "midplane.yaml"),
      [
        "auth:",
        "  issuer: midplane-local",
        "  public_key_file: midplane-verify-key.json",
        "audit: { file: audit.db }",
        "databases:",
        "  main:",
        "    dsn: { env: NOTES_DSN }",
        "    policy: { table_access: { default: read } }",
        "",
      ].join("\n"),
    );
    token = (ttl) =>
      run([
        "token",
        "--config",
        join(dir, "midplane.yaml"),
        "--key",
        join(dir, "midplane-signing-key.json"),
        "--sub",
        "alice@example.com",
        `--ttl=${ttl}`,
      ]);
  });

  it("prints the usage for --help after any command, and for a flag it doesn't know", () => {
    // Value: protects=an agent that asks `token --help` sees `--ttl <seconds>` instead of guessing a format (v0.26.1 threw "Unknown option '--help'" as a log line); fails_when=--help or -h reaches parseArgs, or main's parseArgs error escapes to the log; why_new=only setup and start printed the usage; seam=none
    for (const args of [
      ["--help"],
      ["help"],
      ["token", "--help"],
      ["setup", "-h"],
      ["audit", "verify", "--help"],
    ]) {
      const r = run(args);
      expect(r.status, args.join(" ")).toBe(0);
      expect(r.out).toContain("[--ttl <seconds>]");
      expect(r.err).toBe("");
    }
    const unknown = run(["token", "--expires", "1d"]);
    expect(unknown.status).toBe(2);
    expect(unknown.err).toMatch(/^Unknown option '--expires'/);
    expect(unknown.err).toContain("[--ttl <seconds>]");
  });

  it("refuses a --ttl that isn't a whole number of seconds, and says when a token expires", () => {
    // Value: protects=`--ttl 24h` mints nothing rather than a token that expires in 24 seconds; fails_when=--ttl goes back to parseInt, which reads 24h as 24, 1e3 as 1 and accepts 0, or a ttl past a date's range prints the token, then throws; why_new=no test minted with a --ttl; seam=none
    for (const ttl of [
      "24h",
      "7d",
      "1e3",
      "0",
      "-5",
      "3600.5",
      "9".repeat(13),
    ]) {
      const r = token(ttl);
      expect(r.status, ttl).toBe(2);
      expect(r.out).toBe("");
      expect(r.err).toContain("--ttl is a whole number of seconds");
    }
    const day = token("86400");
    expect(day.status).toBe(0);
    const { iat = 0, exp = 0, sub } = decodeJwt(day.out.trim());
    expect(sub).toBe("alice@example.com");
    expect(exp - iat).toBe(86400);
    expect(day.err).toBe(
      `token for alice@example.com: read on main, until ${new Date(exp * 1000).toISOString()} (86400 seconds)\n`,
    );
  });
});
