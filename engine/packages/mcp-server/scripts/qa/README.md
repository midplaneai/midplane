# QA harness

Manual, opt-in smoke tests for surfaces that can't be covered by `bun test` —
chiefly the interactive `midplane init` wizard, which needs a real TTY and a
live Postgres to introspect. **These are not run by CI.** The wizard's pure
logic is unit-tested in `test/init-wizard.test.ts`; this is the end-to-end check
you run by hand when you touch the wizard.

## Run

```sh
# from packages/mcp-server
DATABASE_URL=postgres://… bun run qa:wizard
# or directly, with explicit choices:
bun scripts/qa/drive-init-wizard.ts \
  --url postgres://… --tenant-column tenant_id --write orders --deny api_keys --keep
```

It introspects your DB (the same way the wizard does), drives the real clack
prompts to grant the `--write` tables, deny the `--deny` tables, and accept the
tenant-less tables as `exempt`, then asserts the written policy is correct and
DSN-free. Exit code is 0 on PASS, 1 on any failure (with a transcript tail).

## Files

- `pty.ts` — generic, reusable PTY driver (Bun's native `Bun.spawn({ terminal })`,
  Bun ≥ 1.3.5). The `waitFor(anchor) → debounce → send` loop is the thing that
  makes driving a clack TUI reliable; reuse it for any future interactive
  command. No native modules, no Python.
- `drive-init-wizard.ts` — the wizard-specific driver + assertions.

## Why not `expect` / node-pty

`node-pty` is broken under Bun; a naive `expect` "sleep then send" races clack's
async render and hangs. `pty.ts` keys off output, not elapsed time — see its
header comment.
