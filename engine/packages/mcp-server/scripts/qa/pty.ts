// Generic pseudo-terminal driver for QA-ing interactive CLIs (clack wizards,
// REPLs, anything that needs a real TTY). Reusable across commands — the
// init wizard is just the first consumer.
//
// Why this exists: clack reads raw keypresses and repaints with cursor-
// positioning + color escapes, so (a) the child must see a real TTY, and
// (b) you can't drive it by sleeping — keystrokes sent before a prompt has
// rendered and attached its listener are silently dropped (the classic
// "expect script hangs" failure). The fix is the loop below: every send is
// gated on the next prompt's anchor text appearing in an ANSI-stripped view
// of the accumulated output, then a short quiet period so we act on a settled
// frame rather than mid-repaint.
//
// Transport: Bun's native PTY (`Bun.spawn({ terminal })`, Bun >= 1.3.5). No
// node-pty native module (which is broken under Bun), no Python. Pin your Bun
// version if you depend on this in automation.

// CSI / OSC / charset escapes. Strip for matching; the visible message text
// survives intact between escapes, which is what we anchor on.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][AB0-9]|\x1b[=>]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
export const stripAnsi = (s: string): string => s.replace(ANSI, "");

// Key sequences clack understands. multiselect: arrows to move, SPACE to
// toggle the focused option, ENTER to submit the set. confirm: y / n direct.
export const Keys = {
  UP: "\x1b[A",
  DOWN: "\x1b[B",
  LEFT: "\x1b[D",
  RIGHT: "\x1b[C",
  SPACE: " ",
  ENTER: "\r",
} as const;

export interface PtySession {
  // Write raw bytes (keystrokes) to the child's stdin.
  send(keys: string): void;
  // Block until `anchor` appears in the ANSI-stripped output AFTER the last
  // match, then until output is quiet for `quiet` ms. Advances an internal
  // cursor so an earlier prompt's text can't satisfy a later wait. Rejects on
  // timeout with the tail of the transcript for debugging.
  waitFor(anchor: string, opts?: { timeout?: number; quiet?: number }): Promise<void>;
  // ANSI-stripped full transcript so far (for assertions / failure dumps).
  output(): string;
  // Resolves with the child's exit code.
  readonly exited: Promise<number>;
  // Close the PTY (call once the wizard has exited).
  close(): void;
  // Force-kill the child (failure paths).
  kill(): void;
}

export interface SpawnPtyOptions {
  cols?: number;
  rows?: number;
  env?: Record<string, string | undefined>;
}

export function spawnPty(cmd: string[], opts: SpawnPtyOptions = {}): PtySession {
  let raw = "";
  let matchFrom = 0; // only match text added after the last anchor

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...opts.env })) {
    if (v !== undefined) env[k] = v;
  }

  const proc = Bun.spawn(cmd, {
    env,
    terminal: {
      // Set generously: clack re-lays-out on terminal width, and a too-narrow
      // PTY can wrap an anchor message across a line boundary — which breaks
      // substring matching in a way that looks exactly like the render race.
      cols: opts.cols ?? 100,
      rows: opts.rows ?? 40,
      data(_t, chunk) {
        raw += new TextDecoder().decode(chunk);
      },
    },
  });
  const term = proc.terminal!;

  const output = () => stripAnsi(raw);

  function waitFor(anchor: string, o: { timeout?: number; quiet?: number } = {}): Promise<void> {
    const timeout = o.timeout ?? 20_000;
    const quiet = o.quiet ?? 80;
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeout;
      let lastLen = -1;
      let stableSince = 0;
      const tick = () => {
        const s = output();
        const idx = s.indexOf(anchor, matchFrom);
        if (idx !== -1) {
          if (s.length === lastLen) {
            if (!stableSince) stableSince = Date.now();
            if (Date.now() - stableSince >= quiet) {
              matchFrom = idx + anchor.length;
              return resolve();
            }
          } else {
            lastLen = s.length;
            stableSince = 0;
          }
        }
        if (Date.now() > deadline) {
          return reject(
            new Error(`timeout waiting for ${JSON.stringify(anchor)}\n--- last 600 chars ---\n${s.slice(-600)}`),
          );
        }
        setTimeout(tick, 15);
      };
      tick();
    });
  }

  return {
    send: (keys) => term.write(keys),
    waitFor,
    output,
    exited: proc.exited,
    close: () => term.close(),
    kill: () => {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    },
  };
}

// Small gap between keystrokes WITHIN an already-rendered, listening prompt.
// The race this whole module solves is prompt-readiness, not inter-key timing;
// a tiny settle here just avoids coalescing arrow presses.
export const tick = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));
