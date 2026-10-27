// The gateway's side of the relay, without a network: a stream's PROXY line
// and where it sends the stream, and the pool of work connections (refill,
// silence, backoff) on a fake clock with work connections that are pairs
// of in-memory streams.

import { Duplex, PassThrough } from "node:stream";
import { proxyLine, RELAY_PING, RELAY_SILENCE_MS } from "@midplane/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Dialed,
  RELAY_KEEP_IDLE,
  readStreamStart,
  routeStream,
  WorkConnections,
} from "../src/relay.ts";

const LINE = proxyLine({
  family: "TCP4",
  source: "203.0.113.7",
  destination: "10.0.0.1",
  sourcePort: 51234,
  destinationPort: 443,
});

/** Everything a stream yields from now until `ms` pass with nothing new. */
async function drain(s: Duplex, ms = 20): Promise<Buffer> {
  const parts: Buffer[] = [];
  s.on("data", (d: Buffer) => parts.push(d));
  s.resume();
  await new Promise((r) => setTimeout(r, ms));
  return Buffer.concat(parts);
}

describe("a relayed stream", () => {
  /** Route a stream that starts with `first`, then gets `more`; where it went. */
  async function route(first: string | Buffer, ...more: (string | Buffer)[]) {
    const socket = new PassThrough();
    socket.pause();
    const went: { to: string; port: number; source: string; bytes: Buffer }[] =
      [];
    const routed = routeStream(socket, Buffer.from(first), {
      tls: (_s, h) => {
        went.push({
          to: "tls",
          port: h.destinationPort,
          source: h.source,
          bytes: Buffer.alloc(0),
        });
      },
      challenge: (_s, h) => {
        went.push({
          to: "challenge",
          port: h.destinationPort,
          source: h.source,
          bytes: Buffer.alloc(0),
        });
      },
    });
    for (const m of more) socket.write(m);
    await routed;
    const bytes = went.length > 0 ? await drain(socket) : Buffer.alloc(0);
    if (went[0]) went[0].bytes = bytes;
    return { went, destroyed: socket.destroyed };
  }

  // protects=a stream goes only where its PROXY line's destination port says, 443 to the HTTPS server and 80 to the challenge handler, with the bytes already read after the line handed over first;
  // fails_when=a line split across reads, or bytes read past it, are lost or reordered; a port other than 443 or 80, an UNKNOWN line, a line over 107 bytes, bytes that aren't a line, or a stream that ends or stalls before its line reach either target;
  // no_claim=the relay's side of the line (cloud's relay tests), or TLS over a real work connection (the e2e tests)
  it("reads the PROXY line, at most 107 bytes, and routes by its destination port alone", async () => {
    // Split across reads, the agent's first bytes in the same read as its end.
    const tls = await route(
      LINE.slice(0, 9),
      `${LINE.slice(9)}\x16\x03\x01`,
      "more",
    );
    expect(tls.went).toEqual([
      {
        to: "tls",
        port: 443,
        source: "203.0.113.7",
        bytes: Buffer.from("\x16\x03\x01more", "latin1"),
      },
    ]);
    expect(tls.destroyed).toBe(false);

    const challenge = await route(
      `${LINE.replace(" 443\r\n", " 80\r\n")}GET /.well-known/acme-challenge/t HTTP/1.1\r\n\r\n`,
    );
    expect(challenge.went).toMatchObject([{ to: "challenge", port: 80 }]);
    expect(challenge.went[0]?.bytes.toString()).toBe(
      "GET /.well-known/acme-challenge/t HTTP/1.1\r\n\r\n",
    );

    // The longest line there is, IPv6 both ways, is still a line.
    const long = proxyLine({
      family: "TCP6",
      source: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      destination: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:fffe",
      sourcePort: 65535,
      destinationPort: 443,
    });
    expect((await route(long)).went).toMatchObject([
      { to: "tls", source: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff" },
    ]);

    for (const bad of [
      LINE.replace(" 443\r\n", " 8443\r\n"),
      LINE.replace(" 443\r\n", " 22\r\n"),
      "PROXY UNKNOWN\r\n",
      "GET /mcp HTTP/1.1\r\nHost: gw\r\n\r\n",
      "\x16\x03\x01\x02\x00",
      `PROXY TCP4 ${"1".repeat(120)}`,
    ]) {
      const r = await route(bad);
      expect(r.went, JSON.stringify(bad)).toEqual([]);
      expect(r.destroyed, JSON.stringify(bad)).toBe(true);
    }

    // Ended before its line was whole.
    const socket = new PassThrough();
    const ended = routeStream(socket, Buffer.from("PROXY TCP4 2"), {
      tls: () => expect.unreachable(),
      challenge: () => expect.unreachable(),
    });
    socket.destroy();
    await ended;

    // Stalled before its line was whole (a line feed alone ends nothing).
    const stalled = new PassThrough();
    expect(
      await readStreamStart(stalled, Buffer.from(`${LINE.trimEnd()}\n`), 50),
    ).toBeNull();
    expect(stalled.destroyed).toBe(true);
  });
});

/** A work connection as the pool sees one, and the relay's end of it. */
function pair(): {
  gateway: Duplex;
  relay: {
    write(b: string | Buffer): void;
    /** The relay closes it. */
    close(): void;
    destroyed(): boolean;
  };
} {
  const toGateway = new PassThrough();
  let destroyed = false;
  const gateway = new Duplex({
    read() {},
    write(_chunk, _enc, done) {
      done();
    },
    destroy(err, done) {
      destroyed = true;
      done(err);
    },
  });
  toGateway.on("data", (d: Buffer) => gateway.push(d));
  return {
    gateway,
    relay: {
      write: (b) => toGateway.write(b),
      close: () => gateway.destroy(),
      destroyed: () => destroyed,
    },
  };
}

describe("the work connections", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  interface Fake {
    pool: WorkConnections;
    /** Every attempt: the token it carried, and the relay's end if accepted. */
    dials: { token: string; relay: ReturnType<typeof pair>["relay"] | null }[];
    streams: { first: string }[];
    logs: Record<string, unknown>[];
    fresh: number;
    changes: number;
    /** What the relay answers the next attempts, in order; then `otherwise`. */
    answers: (number | "down")[];
    otherwise: number | "down";
    /** Bytes the relay sends right after the next 101. */
    after: string[];
    /** How many of the next accepted connections are closed before the pool gets them. */
    dead: number;
  }

  function fake(): Fake {
    const f: Fake = {
      dials: [],
      streams: [],
      logs: [],
      fresh: 0,
      changes: 0,
      answers: [],
      otherwise: 101,
      after: [],
      dead: 0,
      pool: null as unknown as WorkConnections,
    };
    let token = "t0";
    f.pool = new WorkConnections({
      control: "relay.eu.relay.test",
      log: (fields) => f.logs.push(fields),
      random: () => 0.5,
      async token(fresh) {
        if (fresh) token = `t${++f.fresh}`;
        return token;
      },
      async dial(t): Promise<Dialed> {
        const answer = f.answers.shift() ?? f.otherwise;
        if (answer === "down") {
          f.dials.push({ token: t, relay: null });
          return { kind: "failed", code: "ECONNREFUSED" };
        }
        if (answer !== 101) {
          f.dials.push({ token: t, relay: null });
          return { kind: "refused", status: answer };
        }
        const p = pair();
        f.dials.push({ token: t, relay: p.relay });
        if (f.dead > 0) {
          f.dead--;
          p.relay.close();
        }
        return {
          kind: "upgraded",
          socket: p.gateway,
          rest: Buffer.from(f.after.shift() ?? "", "latin1"),
        };
      },
      onStream: (socket, first) => {
        f.streams.push({ first: first.toString("latin1") });
        socket.destroy();
      },
      onChange: () => f.changes++,
    });
    return f;
  }

  /** Let every attempt and answer pending now settle. */
  const tick = () => vi.advanceTimersByTimeAsync(0);

  // protects=the pool keeps 4 idle work connections, opens one as each is used, hands a stream its first bytes past the pings, keeps one that hears pings, drops one silent for 75 s, and tells the link only of a change between up and a refusal;
  // fails_when=a used or silent connection isn't replaced, more than 4 are opened while idle, pings reach a stream or keep it from starting, a stream that follows the 101 at once is missed, a pinged connection is dropped, or each stream makes the link sync;
  // no_claim=the relay's ping interval (25 s, cloud's tests), or real sockets' close timing
  it("keeps 4 idle, replaces each as it is used, closes or falls silent", async () => {
    const f = fake();
    // The first connection's 101 comes with a stream already waiting.
    f.after.push(`\x00${LINE}hello`);
    f.pool.start();
    await tick();
    expect(RELAY_KEEP_IDLE).toBe(4);
    expect(f.streams).toEqual([{ first: `${LINE}hello` }]);
    expect(f.dials).toHaveLength(5);
    expect(f.pool.status()).toEqual({ idle: 4, refused: null });
    let ready = false;
    void f.pool.ready(new AbortController().signal).then(() => {
      ready = true;
    });
    await tick();
    expect(ready).toBe(true);

    // Pings keep it idle and say nothing.
    const idle = f.dials.slice(1).map((d) => d.relay);
    idle[0]?.write(Buffer.of(RELAY_PING, RELAY_PING));
    await tick();
    expect(f.streams).toHaveLength(1);
    expect(f.dials).toHaveLength(5);

    // A stream: a ping, then its line, in one read.
    idle[1]?.write(
      Buffer.concat([Buffer.of(RELAY_PING), Buffer.from(`${LINE}x`)]),
    );
    await tick();
    expect(f.streams.at(-1)).toEqual({ first: `${LINE}x` });
    expect(f.dials).toHaveLength(6);
    expect(f.pool.status().idle).toBe(4);
    // Up once, however many streams use and replace connections.
    expect(f.changes).toBe(1);

    // Silence: the pinged one stays; the 3 silent since they opened are
    // dropped, which counts as a failure (they never heard a word), so they
    // are replaced after the first wait.
    const replacement = f.dials[5]?.relay;
    await vi.advanceTimersByTimeAsync(RELAY_SILENCE_MS - 1_000);
    idle[0]?.write(Buffer.of(RELAY_PING));
    await vi.advanceTimersByTimeAsync(1_001);
    expect(idle[0]?.destroyed()).toBe(false);
    expect(idle[2]?.destroyed()).toBe(true);
    expect(idle[3]?.destroyed()).toBe(true);
    expect(replacement?.destroyed()).toBe(true);
    expect(
      f.logs.filter((l) => l.msg === "relay work connection silent; replaced"),
    ).toHaveLength(3);
    expect(f.pool.status()).toMatchObject({
      idle: 1,
      refused: { status: 0, code: "ECONNRESET" },
    });
    expect(f.dials).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.pool.status()).toEqual({ idle: 4, refused: null });
    expect(f.dials).toHaveLength(9);
    expect(f.changes).toBe(3);

    f.pool.close();
    await tick();
    expect(f.dials).toHaveLength(9);
    expect(f.dials.every((d) => d.relay?.destroyed() !== false)).toBe(true);
  });

  // protects=a failed attempt waits 1 s, doubling to 60 s, for every connection at once; a 101 starts again from 1 s; a 401 gets a fresh token once, then waits; a 403 is said once, as a sentence, and waits 60 s; the status names the last refusal until a 101;
  // fails_when=attempts don't wait, wait per connection rather than per round, grow past 60 s, keep the long wait after a 101, redial at once a relay that accepts and closes, mint a token for every 401 or never, log each 403, or keep a refusal after the relay accepts;
  // no_claim=the waits' spread (75 % to 125 %, pinned to 100 % here), or the relay's answers themselves (cloud's tests)
  it("waits 1 s doubling to 60 s, from 1 s again after a 101; a 401 refreshes once, a 403 waits longest", async () => {
    const f = fake();
    f.otherwise = "down";
    f.pool.start();
    await tick();
    /** When each round of attempts began, in seconds from the start. */
    const rounds: number[] = [];
    let seen = 0;
    for (let s = 0; s <= 300; s++) {
      if (f.dials.length > seen) {
        rounds.push(s);
        expect(f.dials.length - seen).toBe(4);
        seen = f.dials.length;
      }
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(rounds).toEqual([0, 1, 3, 7, 15, 31, 63, 123, 183, 243]);
    expect(f.pool.status()).toMatchObject({
      idle: 0,
      refused: { status: 0, code: "ECONNREFUSED" },
    });
    expect(
      f.logs.filter((l) => l.msg === "relay connection failed"),
    ).toHaveLength(rounds.length);

    // The relay is back: accepted at the next round, and the waits start again.
    f.otherwise = 101;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.pool.status()).toEqual({ idle: 4, refused: null });
    f.otherwise = "down";
    const before = f.dials.length;
    for (const d of f.dials.slice(-4)) d.relay?.write(`${LINE}`);
    await tick();
    expect(f.dials.length).toBe(before + 4);
    await vi.advanceTimersByTimeAsync(999);
    expect(f.dials.length).toBe(before + 4);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.dials.length).toBe(before + 8);

    // A relay that accepts, then closes before a word: no redial until the
    // wait, as for any failure. One closed before the pool held it, too.
    const k = fake();
    k.dead = 1;
    k.pool.start();
    await tick();
    expect(k.dials).toHaveLength(4);
    expect(k.pool.status().idle).toBe(3);
    for (const d of k.dials) d.relay?.close();
    await tick();
    expect(k.pool.status().idle).toBe(0);
    await vi.advanceTimersByTimeAsync(999);
    expect(k.dials).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(k.dials).toHaveLength(8);
    expect(k.pool.status()).toEqual({ idle: 4, refused: null });
    k.pool.close();

    // 401: one fresh token, then the wait.
    const g = fake();
    g.otherwise = 401;
    g.pool.start();
    await tick();
    expect(g.dials.map((d) => d.token)).toEqual([
      "t0",
      "t0",
      "t0",
      "t0",
      "t1",
      "t2",
      "t3",
      "t4",
    ]);
    await vi.advanceTimersByTimeAsync(999);
    expect(g.dials).toHaveLength(8);
    await vi.advanceTimersByTimeAsync(1);
    expect(g.dials).toHaveLength(16);
    expect(g.pool.status().refused).toMatchObject({ status: 401, code: null });

    // 403: said once, as a sentence; a minute between rounds.
    const h = fake();
    h.otherwise = 403;
    h.pool.start();
    await tick();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.dials).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.dials).toHaveLength(8);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.dials).toHaveLength(16);
    expect(h.logs).toEqual([
      {
        level: "warn",
        msg: "The relay at relay.eu.relay.test refused this gateway: Midplane Cloud holds no relay URL for it, so agents can't reach it there. Only enrolling gives a gateway one. It tries again every minute.",
      },
    ]);
    expect(h.pool.status().refused).toMatchObject({ status: 403 });
    // The dashboard hears a change, not every refusal.
    expect(h.changes).toBe(1);

    for (const x of [f, g, h]) x.pool.close();
  });
});
