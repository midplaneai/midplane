// The gateway's side of the relay, whose wire protocol is @midplane/protocol's
// relay.ts: how agents reach a gateway that only connects out. It keeps a
// few idle work connections open to the relay's control name, each over TLS
// verified against the system's CAs and upgraded with the link access
// token. When an agent connects to the gateway's relay host, the relay
// writes a PROXY line on one of them, then the agent's still-encrypted
// bytes, and TLS ends here. The line's destination port says where the
// stream goes, and nowhere else: 443 to the gateway's HTTPS server, 80 to
// its ACME challenge handler (server.ts wires both).
//
// It keeps 4 idle and opens a replacement as each is used. A failed attempt
// waits 1 s, doubling to 60 s, until the relay accepts one again. A 401
// gets a fresh token once first. A 403 (the cloud holds no relay URL for
// this gateway) is said once and waits the longest. An idle connection
// hears a ping every 25 s; one silent for 75 s is dropped and replaced. One
// that closes before it heard anything counts as a failed attempt, so a
// relay that accepts and closes at once isn't dialed again without a wait.

import type { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import {
  type ProxyHeader,
  RELAY_CONNECT_PATH,
  RELAY_PING,
  RELAY_PORTS,
  RELAY_SILENCE_MS,
  RELAY_UPGRADE,
  type RelayStatus,
  readProxyLine,
} from "@midplane/protocol";
import type { Logger } from "./log.ts";

/** Idle work connections a gateway keeps open: half of what the relay allows. */
export const RELAY_KEEP_IDLE = 4;
/** Waits after a failed attempt: the first, doubling to the last. */
export const RELAY_BACKOFF = { minMs: 1_000, maxMs: 60_000 };
/** The TLS handshake and the upgrade's answer arrive within this. */
const DIAL_MS = 10_000;
/** The upgrade's answer is at most this long. */
const ANSWER_MAX = 8 * 1024;
/** A stream's PROXY line arrives whole within this. */
const PROXY_LINE_MS = 10_000;

// ── one work connection ────────────────────────────────────────────────────

/** How an attempt at a work connection ended. */
export type Dialed =
  /** 101: idle until a stream starts; `rest` is what followed the answer. */
  | { kind: "upgraded"; socket: Duplex; rest: Buffer }
  /** Any other answer: 401 the token, 403 no relay URL, 429 too many idle. */
  | { kind: "refused"; status: number }
  /** No answer: why, as an error code. */
  | { kind: "failed"; code: string; message?: string };

export interface RelayAddress {
  /** The relay's own name, `relay.<domain>`: the SNI and the name verified. */
  control: string;
  /** For tests: where it listens instead of `<control>:443`. */
  connect?: { host: string; port: number };
  /** For tests: the CA trusted instead of the system's. */
  ca?: string;
}

/**
 * Open one work connection: TLS to the control name, then `GET /v1/connect`
 * with the link access token and `Upgrade: midplane-relay`.
 */
export function dialRelay(
  relay: RelayAddress,
  token: string,
  signal: AbortSignal,
): Promise<Dialed> {
  return new Promise((resolve) => {
    const socket = tlsConnect({
      host: relay.connect?.host ?? relay.control,
      port: relay.connect?.port ?? RELAY_PORTS.tls,
      servername: relay.control,
      ...(relay.ca ? { ca: relay.ca } : {}),
    });
    // Errors close it; whoever holds it hears the close.
    socket.on("error", () => {});
    let answer = Buffer.alloc(0);
    let done = false;
    const finish = (d: Dialed) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (d.kind === "upgraded") socket.pause();
      else socket.destroy();
      resolve(d);
    };
    const abort = () => finish({ kind: "failed", code: "ABORT_ERR" });
    const timer = setTimeout(
      () => finish({ kind: "failed", code: "ETIMEDOUT" }),
      DIAL_MS,
    );
    const onError = (err: NodeJS.ErrnoException) =>
      finish({
        kind: "failed",
        code: err.code ?? "ERROR",
        message: err.message,
      });
    const onClose = () => finish({ kind: "failed", code: "ECONNRESET" });
    const onData = (chunk: Buffer) => {
      answer = Buffer.concat([answer, chunk]);
      const end = answer.indexOf("\r\n\r\n");
      if (end < 0) {
        if (answer.length > ANSWER_MAX)
          finish({ kind: "failed", code: "EPROTO" });
        return;
      }
      const head = answer.subarray(0, end).toString("latin1");
      const status = /^HTTP\/1\.1 (\d{3})/.exec(head)?.[1];
      if (!status) return finish({ kind: "failed", code: "EPROTO" });
      if (status !== "101") {
        return finish({ kind: "refused", status: Number(status) });
      }
      const upgrade = /\r\nupgrade: *([^\r]*)/i.exec(head)?.[1]?.trim();
      if (upgrade?.toLowerCase() !== RELAY_UPGRADE) {
        return finish({ kind: "failed", code: "EPROTO" });
      }
      finish({ kind: "upgraded", socket, rest: answer.subarray(end + 4) });
    };
    socket.on("data", onData);
    socket.on("error", onError);
    socket.once("close", onClose);
    socket.once("secureConnect", () => {
      socket.write(
        `GET ${RELAY_CONNECT_PATH} HTTP/1.1\r\nHost: ${relay.control}\r\nAuthorization: Bearer ${token}\r\nConnection: Upgrade\r\nUpgrade: ${RELAY_UPGRADE}\r\n\r\n`,
      );
    });
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

// ── the pool ───────────────────────────────────────────────────────────────

export interface WorkConnectionsOptions {
  /** Open one work connection with this token. */
  dial(token: string, signal: AbortSignal): Promise<Dialed>;
  /** The link access token; `fresh` gets a new one rather than the one held. */
  token(fresh: boolean): Promise<string>;
  /**
   * A stream begins on a work connection, now no longer idle: its first
   * bytes, already read, and the connection, paused.
   */
  onStream(socket: Duplex, first: Buffer): void;
  /** The relay's name, for the log. */
  control: string;
  log: Logger;
  /** Told when the status changes: connected or not, or another refusal. */
  onChange?: () => void;
  /** For tests. */
  keep?: number;
  silenceMs?: number;
  backoff?: { minMs: number; maxMs: number };
  /** Spreads each wait over 75 % to 125 %, so gateways don't come back at once. */
  random?: () => number;
}

/** A gateway's idle work connections, kept open and replaced as they are used. */
export class WorkConnections {
  private readonly o: WorkConnectionsOptions;
  private readonly keep: number;
  private readonly silenceMs: number;
  private readonly backoff: { minMs: number; maxMs: number };
  /** Each idle connection, with the timer that drops it once silent. */
  private readonly idle = new Map<Duplex, NodeJS.Timeout>();
  /** Connections carrying a stream, closed with the pool. */
  private readonly streams = new Set<Duplex>();
  private dialing = 0;
  private delay: number;
  /** The wait after a failed attempt; nothing is opened until it ends. */
  private retry: NodeJS.Timeout | null = null;
  private refused: RelayStatus["refused"] = null;
  /** Whether the relay accepted a connection since its last refusal. */
  private up = false;
  /** Whether this run of 403s has been said. */
  private told403 = false;
  private readonly stopper = new AbortController();
  private waiters: (() => void)[] = [];
  /** The status last told, so only a change is. */
  private told = "";

  constructor(o: WorkConnectionsOptions) {
    this.o = o;
    this.keep = o.keep ?? RELAY_KEEP_IDLE;
    this.silenceMs = o.silenceMs ?? RELAY_SILENCE_MS;
    this.backoff = o.backoff ?? RELAY_BACKOFF;
    this.delay = this.backoff.minMs;
  }

  start(): void {
    this.fill();
  }

  /** Idle connections now, and why the relay last refused one, until it accepts one. */
  status(): RelayStatus {
    return { idle: this.idle.size, refused: this.refused };
  }

  /** Settles once a work connection is open: the relay can reach this gateway. */
  ready(signal: AbortSignal): Promise<void> {
    if (this.idle.size > 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        this.waiters = this.waiters.filter((w) => w !== done);
        reject(signal.reason);
      };
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      this.waiters.push(done);
    });
  }

  close(): void {
    this.stopper.abort();
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    for (const [socket, timer] of this.idle) {
      clearTimeout(timer);
      socket.destroy();
    }
    this.idle.clear();
    for (const socket of this.streams) socket.destroy();
  }

  private get stopped(): boolean {
    return this.stopper.signal.aborted;
  }

  /** Open connections until `keep` are idle or opening, unless waiting. */
  private fill(): void {
    if (this.stopped || this.retry) return;
    while (this.idle.size + this.dialing < this.keep) void this.open();
  }

  private async open(): Promise<void> {
    this.dialing++;
    let d: Dialed;
    try {
      d = await this.attempt();
    } finally {
      this.dialing--;
    }
    if (this.stopped) {
      if (d.kind === "upgraded") d.socket.destroy();
      return;
    }
    if (d.kind === "upgraded") {
      this.accepted();
      this.keepIdle(d.socket, d.rest);
      this.fill();
    } else {
      this.failed(d);
    }
  }

  /** One attempt; a 401 is tried once more with a fresh token. */
  private async attempt(): Promise<Dialed> {
    for (let fresh = false; ; fresh = true) {
      let token: string;
      try {
        token = await this.o.token(fresh);
      } catch (err) {
        return {
          kind: "failed",
          code: "NO_LINK_TOKEN",
          message: (err as Error).message,
        };
      }
      const d = await this.o.dial(token, this.stopper.signal);
      if (d.kind === "refused" && d.status === 401 && !fresh) continue;
      return d;
    }
  }

  /**
   * A 101: the next wait is the first again. One already set still runs
   * out, so a relay that accepts some and closes them isn't dialed again
   * without a pause.
   */
  private accepted(): void {
    this.delay = this.backoff.minMs;
    this.refused = null;
    this.up = true;
    this.told403 = false;
    for (const done of this.waiters.splice(0)) done();
  }

  /** A failed attempt: wait, unless this round's wait is already set. */
  private failed(d: Exclude<Dialed, { kind: "upgraded" }>): void {
    this.refused = {
      status: d.kind === "refused" ? d.status : 0,
      code: d.kind === "failed" ? d.code : null,
      at: new Date().toISOString(),
    };
    this.up = false;
    this.changed();
    if (this.retry) return;
    const noUrl = d.kind === "refused" && d.status === 403;
    if (noUrl) this.delay = this.backoff.maxMs;
    const random = this.o.random ?? Math.random;
    const wait = Math.round(this.delay * (0.75 + random() / 2));
    if (noUrl) {
      if (!this.told403) {
        this.told403 = true;
        this.o.log({
          level: "warn",
          msg: `The relay at ${this.o.control} refused this gateway: Midplane Cloud holds no relay URL for it, so agents can't reach it there. Only enrolling gives a gateway one. It tries again every minute.`,
        });
      }
    } else {
      this.o.log({
        level: "warn",
        msg: "relay connection failed",
        relay: this.o.control,
        ...(d.kind === "refused"
          ? { status: d.status }
          : { code: d.code, ...(d.message ? { error: d.message } : {}) }),
        retry_ms: wait,
      });
    }
    this.delay = Math.min(this.backoff.maxMs, this.delay * 2);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.fill();
    }, wait);
  }

  /**
   * Hold a connection idle: it hears only pings, until a byte that isn't
   * one starts a stream. One silent too long is dropped; either way a new
   * one is opened.
   */
  private keepIdle(socket: Duplex, rest: Buffer): void {
    socket.on("error", () => {});
    // Closed between its answer and now: its close was missed.
    if (socket.destroyed) {
      this.failed({ kind: "failed", code: "ECONNRESET" });
      return;
    }
    /** Whether it heard anything, a ping or a stream, before it closed. */
    let heard = false;
    const silent = () => {
      this.o.log({
        level: "info",
        msg: "relay work connection silent; replaced",
        relay: this.o.control,
        silent_ms: this.silenceMs,
      });
      socket.destroy();
    };
    this.idle.set(socket, setTimeout(silent, this.silenceMs));
    const onClose = () => {
      clearTimeout(this.idle.get(socket));
      if (!this.idle.delete(socket)) return;
      if (heard) this.fill();
      else this.failed({ kind: "failed", code: "ECONNRESET" });
    };
    const onData = (chunk: Buffer) => {
      heard = true;
      let at = 0;
      while (at < chunk.length && chunk[at] === RELAY_PING) at++;
      clearTimeout(this.idle.get(socket));
      if (at === chunk.length) {
        this.idle.set(socket, setTimeout(silent, this.silenceMs));
        return;
      }
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.pause();
      this.idle.delete(socket);
      this.streams.add(socket);
      socket.once("close", () => this.streams.delete(socket));
      this.fill();
      this.o.onStream(socket, chunk.subarray(at));
    };
    socket.on("data", onData);
    socket.once("close", onClose);
    this.changed();
    if (rest.length > 0) onData(rest);
    if (this.idle.has(socket)) socket.resume();
  }

  /**
   * Tell of a change between connecting, up and a refusal, or from one
   * refusal to another; not of connections used and replaced, which a busy
   * gateway does all the time.
   */
  private changed(): void {
    const now = JSON.stringify(
      this.refused ? [this.refused.status, this.refused.code] : this.up,
    );
    if (now === this.told) return;
    this.told = now;
    this.o.onChange?.();
  }
}

// ── a stream ───────────────────────────────────────────────────────────────

/**
 * A stream's PROXY line, at most 107 bytes, read from what was already
 * read and then from the connection: its header, and every byte after it
 * already read. Null when it isn't one, names no addresses (`UNKNOWN`), or
 * doesn't arrive in time; the connection is closed then.
 */
export function readStreamStart(
  socket: Duplex,
  first: Buffer,
  ms = PROXY_LINE_MS,
): Promise<{ header: ProxyHeader; rest: Buffer } | null> {
  return new Promise((resolve) => {
    let bytes = first;
    let done = false;
    const finish = (r: { header: ProxyHeader; rest: Buffer } | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.pause();
      if (!r) socket.destroy();
      resolve(r);
    };
    const check = () => {
      const line = readProxyLine(bytes);
      if (line === "more") return;
      if (line === "invalid" || !line.header) return finish(null);
      finish({ header: line.header, rest: bytes.subarray(line.length) });
    };
    const onData = (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      check();
    };
    const onClose = () => finish(null);
    const timer = setTimeout(() => finish(null), ms);
    socket.on("data", onData);
    socket.once("close", onClose);
    check();
    if (!done) socket.resume();
  });
}

/** Where a relayed stream may go: the only two places. */
export interface StreamTargets {
  /** TLS for the gateway's HTTPS server. */
  tls(socket: Duplex, header: ProxyHeader): void;
  /** One ACME challenge request, for the challenge handler. */
  challenge(socket: Duplex, header: ProxyHeader): void;
}

/**
 * Send a stream where its PROXY line's destination port says, with the
 * bytes after the line given back first; anything else closes it.
 */
export async function routeStream(
  socket: Duplex,
  first: Buffer,
  targets: StreamTargets,
): Promise<void> {
  const start = await readStreamStart(socket, first);
  if (!start) return;
  if (start.rest.length > 0) socket.unshift(start.rest);
  switch (start.header.destinationPort) {
    case RELAY_PORTS.tls:
      return targets.tls(socket, start.header);
    case RELAY_PORTS.challenge:
      return targets.challenge(socket, start.header);
    default:
      socket.destroy();
  }
}

/**
 * Show a relayed connection as coming from the agent its PROXY line names,
 * not the relay: its remote address, for logs and rate limits.
 */
export function presentAs(socket: object, header: ProxyHeader): void {
  Object.defineProperties(socket, {
    remoteAddress: { value: header.source, configurable: true },
    remotePort: { value: header.sourcePort, configurable: true },
    remoteFamily: {
      value: header.family === "TCP4" ? "IPv4" : "IPv6",
      configurable: true,
    },
  });
}
