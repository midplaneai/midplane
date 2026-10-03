// Questions for `midplane setup`. On a terminal a secret is typed without
// echo; from a pipe (tests, scripts) each answer is the next line, and none
// is echoed. The end of input, Ctrl-C or the signal ends every question,
// pending or later, with PromptClosed.

import { createInterface } from "node:readline";
import { Writable } from "node:stream";

/** No answer will come: the input ended, or the person stopped setup. */
export class PromptClosed extends Error {
  readonly interrupted: boolean;
  constructor(interrupted: boolean) {
    super(interrupted ? "interrupted" : "the input ended");
    this.name = "PromptClosed";
    this.interrupted = interrupted;
  }
}

export interface Prompter {
  /** The next answer, without its line ending. */
  ask(question: string, o?: { secret?: boolean }): Promise<string>;
  close(): void;
}

export interface PrompterOptions {
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  output?: NodeJS.WritableStream;
  /** Ends every question, as Ctrl-C does. */
  signal?: AbortSignal;
  /** Ctrl-C on the terminal, which arrives as input rather than a signal. */
  onInterrupt?: () => void;
}

export function openPrompter(o: PrompterOptions = {}): Prompter {
  const input = o.input ?? process.stdin;
  const output = o.output ?? process.stdout;
  const terminal = input.isTTY === true;
  // On a terminal readline echoes what is typed; muted, it echoes nothing,
  // not even the redraws that would show a secret's length. It is muted
  // but while a question that isn't secret waits, so nothing typed ahead
  // (a connection string, pasted during a test) is shown either.
  let muted = terminal;
  const echo = new Writable({
    write(chunk, encoding, done) {
      if (!muted) output.write(chunk, encoding);
      done();
    },
  });
  // No history: Up would bring a connection string back, in clear.
  const rl = createInterface({
    input,
    ...(terminal ? { output: echo } : {}),
    terminal,
    historySize: 0,
  });
  const lines: string[] = [];
  let waiting: {
    resolve: (line: string) => void;
    reject: (err: PromptClosed) => void;
  } | null = null;
  let closed: PromptClosed | null = null;

  const end = (why: PromptClosed) => {
    closed ??= why;
    const w = waiting;
    waiting = null;
    w?.reject(closed);
    rl.close();
  };
  rl.on("line", (line) => {
    const w = waiting;
    waiting = null;
    if (w) w.resolve(line);
    else lines.push(line);
  });
  rl.on("close", () => end(new PromptClosed(false)));
  rl.on("SIGINT", () => {
    end(new PromptClosed(true));
    o.onInterrupt?.();
  });
  const onAbort = () => end(new PromptClosed(true));
  o.signal?.addEventListener("abort", onAbort, { once: true });
  if (o.signal?.aborted) onAbort();

  return {
    async ask(question, { secret = false } = {}) {
      // Lines read before the input ended are still answers; none are
      // after an interrupt.
      if (closed?.interrupted) throw closed;
      const queued = lines.shift();
      if (queued === undefined && closed) throw closed;
      if (terminal && !closed) {
        // As readline's prompt, so its redraws keep the question; a secret
        // one is written past the mute, and its redraws show nothing.
        rl.setPrompt(question);
        if (secret) {
          output.write(question);
        } else {
          muted = false;
          rl.prompt();
        }
      } else {
        output.write(question);
      }
      if (queued !== undefined) {
        muted = terminal;
        output.write("\n");
        return queued;
      }
      try {
        return await new Promise<string>((resolve, reject) => {
          waiting = { resolve, reject };
        });
      } finally {
        // Readline ends a line it echoed; a muted one, or a pipe's, ends here.
        if (muted || !terminal) output.write("\n");
        muted = terminal;
      }
    },
    close() {
      o.signal?.removeEventListener("abort", onAbort);
      closed ??= new PromptClosed(false);
      rl.close();
    },
  };
}
