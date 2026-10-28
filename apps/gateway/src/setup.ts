// `midplane setup`: a linked gateway's folder, from a few questions. It asks
// for each database's connection string, tests it (warning of a role that is
// a superuser or owns tables), suggests a name, writes the config and its
// secrets, and enrolls, naming every database so the cloud adds those the
// project lacks. A database added that way has no policy, so nothing in it
// is readable until someone publishes one. Then the gateway serves, as
// `midplane gateway --config <dir>/midplane.yaml` would.
//
// A server gateway serves TLS: with the certificate in `--tls-dir`, or with
// `--acme` one it gets from Let's Encrypt itself, which setup obtains, after
// the questions and before enrolling, and the gateway then renews.
//
// With `--relay`, agents reach the gateway through Midplane's relay instead,
// at `https://<slug>.<relay domain>`, and it needs no host name, DNS record
// or open port. Setup asks the cloud for its relay before the first
// question; a cloud without one is refused. The gateway listens on loopback,
// for health checks, and gets its certificate as it first starts, through
// the relay, whose challenges reach it over the work connections its link
// token opens: so only once it has enrolled.
//
// The enrollment token is spent last: the flags, the folder, the port and
// the certificate (or the challenge's port) are checked before the first
// question, and each connection string is tested as it is given. A failure
// up to and including enrollment removes everything setup wrote, and every
// file is created exclusively, so setup never follows or overwrites one. A
// connection string goes nowhere but its own file: not to the terminal, an
// error or the cloud. `midplane start` sets up from the environment with the
// same steps (start.ts); there each connection string stays in its variable,
// which the config names.

import { randomBytes, X509Certificate } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createServer, isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import {
  type CatalogSnapshot,
  connectionErrorLine,
  DatabaseIdSchema,
  EnrollmentTokenSchema,
  GATEWAY_SLUG_ALPHABET,
  LINK_API_PREFIX,
  type RelayInfo,
  RelayInfoSchema,
  relayControlName,
  relaySlugOf,
} from "@midplane/protocol";
import {
  ACME_FILES,
  ACME_HTTP_PORT,
  AcmeError,
  authorityName,
  type ChallengeListener,
  ChallengeTokens,
  LETS_ENCRYPT,
  listenForChallenges,
  obtainCertificate,
  type Polling,
} from "./acme.ts";
import { introspect } from "./catalog.ts";
import { certificateProblem } from "./certificates.ts";
import { ConfigError, isLoopback, parseLinkedConfig } from "./config.ts";
import { DatabaseExecutor, errorCode } from "./executor.ts";
import {
  type Enrollment,
  EnrollmentError,
  enroll,
  identityText,
} from "./identity.ts";
import { PromptClosed, type Prompter } from "./prompt.ts";
import { resourceOf } from "./urls.ts";

/** A problem setup stops at; the message is for the person running it. */
export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupError";
  }
}

/** A server gateway's port, and the first a gateway on this machine tries. */
export const SETUP_PORT = 7433;
/** A gateway on this machine takes the first free port of 7433-7442. */
const MACHINE_PORTS = 10;
export const DEFAULT_TLS_DIR = "/etc/midplane/tls";

const ID_RULE =
  "a name starts with a lowercase letter and has up to 32 lowercase letters, digits, - or _";

/** `gw-` and 8 random base32 characters, as the dashboard makes them. */
export function newGatewaySlug(): string {
  // 256 is a multiple of 32, so every character is equally likely.
  return `gw-${Array.from(randomBytes(8), (b) => GATEWAY_SLUG_ALPHABET[b & 31]).join("")}`;
}

// ── the flags ──────────────────────────────────────────────────────────────

/**
 * What setup calls each input in what it says: a flag, or for `midplane
 * start` an environment variable. `acme` is what asks for an automatic
 * certificate, null where one always is.
 */
export interface InputNames {
  cloud: string;
  token: string;
  url: string;
  acme: string | null;
  acmeDirectory: string;
  port: string;
}

export const FLAG_NAMES: InputNames = {
  cloud: "--cloud",
  token: "--token",
  url: "--url",
  acme: "--acme",
  acmeDirectory: "--acme-directory",
  port: "--port",
};

/** The command line, as `parseArgs` reads it. */
export interface SetupFlags {
  cloud?: string | undefined;
  token?: string | undefined;
  database?: string[] | undefined;
  url?: string | undefined;
  "tls-dir"?: string | undefined;
  acme?: boolean | undefined;
  "acme-directory"?: string | undefined;
  relay?: boolean | undefined;
  port?: string | undefined;
  dir?: string | undefined;
  "no-start"?: boolean | undefined;
}

export interface SetupPlan {
  /** Midplane Cloud's origin. */
  cloudUrl: string;
  token: string;
  /** Ids already in the project, asked for first. */
  databases: string[];
  /**
   * A server: every interface, with TLS, at this origin; its certificate
   * from files in a folder, or from an ACME directory.
   */
  server: {
    url: string;
    certificate:
      | { kind: "files"; dir: string }
      | { kind: "acme"; directoryUrl: string };
  } | null;
  /**
   * Through Midplane's relay, at a URL the cloud's relay domain gives, with
   * a certificate from this ACME directory, got through the relay.
   */
  relay: { directoryUrl: string } | null;
  /** The port asked for, if any. */
  port: number | null;
  /** Where to write, as given. */
  dir: string;
  slug: string;
  start: boolean;
  /** What its messages call each input. */
  names: InputNames;
}

/** A server's URL as `public_urls` lists it: the origin, if it can be one. */
function serverOrigin(text: string, name: string): string {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new SetupError(`${name}: enter the full URL, starting with https://`);
  }
  if (url.protocol !== "https:") {
    throw new SetupError(
      `${name} must start with https://: off this machine the gateway needs TLS`,
    );
  }
  if (url.username || url.password) {
    throw new SetupError(`${name} can't carry credentials`);
  }
  if (url.search || url.hash) {
    throw new SetupError(`${name} can't have a query or fragment`);
  }
  if (!/^\/(mcp\/?)?$/.test(url.pathname)) {
    throw new SetupError(
      `${name} names the host only: the gateway answers at its root`,
    );
  }
  return url.origin;
}

/** An ACME directory's URL: https, or http on this machine (a test's). */
function acmeDirectory(text: string | undefined, name: string): string {
  if (text === undefined) return LETS_ENCRYPT;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new SetupError(`${name} must be an ACME directory's URL`);
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLoopback(url.hostname))
  ) {
    throw new SetupError(`${name} must use https (http only on this machine)`);
  }
  return url.href;
}

/** Check the flags, without touching the disk or the network. */
export function planSetup(
  flags: SetupFlags,
  slug = newGatewaySlug(),
  names: InputNames = FLAG_NAMES,
): SetupPlan {
  if (!flags.cloud || !flags.token) {
    throw new SetupError(
      "setup needs --cloud <url> and --token <mpe1_…>: copy the command from your project's Gateways page",
    );
  }
  if (!EnrollmentTokenSchema.safeParse(flags.token).success) {
    throw new SetupError(
      `${names.token} is not a Midplane enrollment token (mpe1_…)`,
    );
  }
  let cloud: URL;
  try {
    cloud = new URL(flags.cloud);
  } catch {
    throw new SetupError(
      `${names.cloud} must be Midplane Cloud's URL, e.g. https://eu.app.midplane.ai`,
    );
  }
  if (
    cloud.protocol !== "https:" &&
    !(cloud.protocol === "http:" && isLoopback(cloud.hostname))
  ) {
    throw new SetupError(
      `${names.cloud} must use https (http only on this machine)`,
    );
  }
  if (
    flags.relay &&
    (flags.url !== undefined || flags.acme || flags["tls-dir"] !== undefined)
  ) {
    throw new SetupError(
      "--relay doesn't take --url, --acme or --tls-dir: the gateway gets a Midplane URL, and a certificate for it through the relay",
    );
  }
  if (flags.url === undefined && flags["tls-dir"] !== undefined) {
    throw new SetupError("--tls-dir goes with --url");
  }
  if (flags.url === undefined && flags.acme) {
    throw new SetupError("--acme goes with --url");
  }
  if (flags.acme && flags["tls-dir"] !== undefined) {
    throw new SetupError(
      "--acme gets the gateway a certificate, so it doesn't take --tls-dir",
    );
  }
  if (!flags.acme && !flags.relay && flags["acme-directory"] !== undefined) {
    throw new SetupError("--acme-directory goes with --acme");
  }
  const relay: SetupPlan["relay"] = flags.relay
    ? {
        directoryUrl: acmeDirectory(
          flags["acme-directory"],
          names.acmeDirectory,
        ),
      }
    : null;
  let server: SetupPlan["server"] = null;
  if (flags.url !== undefined) {
    const url = serverOrigin(flags.url, names.url);
    if (!flags.acme) {
      server = {
        url,
        certificate: {
          kind: "files",
          dir: flags["tls-dir"] ?? DEFAULT_TLS_DIR,
        },
      };
    } else {
      if (isIP(new URL(url).hostname.replace(/^\[(.*)\]$/, "$1"))) {
        throw new SetupError(
          `${names.acme ? `${names.acme}: ` : ""}an automatic certificate needs a host name, and ${names.url} names an IP address`,
        );
      }
      server = {
        url,
        certificate: {
          kind: "acme",
          directoryUrl: acmeDirectory(
            flags["acme-directory"],
            names.acmeDirectory,
          ),
        },
      };
    }
  }
  const databases = flags.database ?? [];
  const seen = new Set<string>();
  for (const id of databases) {
    if (!DatabaseIdSchema.safeParse(id).success) {
      throw new SetupError(`--database ${id}: ${ID_RULE}`);
    }
    if (seen.has(id)) throw new SetupError(`--database ${id} is listed twice`);
    seen.add(id);
  }
  let port: number | null = null;
  if (flags.port !== undefined) {
    port = /^\d{1,5}$/.test(flags.port) ? Number(flags.port) : 0;
    if (port < 1 || port > 65535) {
      throw new SetupError(`${names.port} must be a port number, 1 to 65535`);
    }
  }
  return {
    cloudUrl: cloud.origin,
    token: flags.token,
    databases,
    server,
    relay,
    port,
    dir: flags.dir ?? slug,
    slug,
    start: !flags["no-start"],
    names,
  };
}

// ── the folder, the port and the certificate ──────────────────────────────

/**
 * A server's certificate: its files, absolute, or where to get one, with
 * the challenge answered on `httpPort` or, relayed, through the relay.
 */
export type SetupTls =
  | { kind: "files"; certFile: string; keyFile: string }
  | { kind: "acme"; directoryUrl: string; httpPort: number }
  | { kind: "relayed"; directoryUrl: string };

export interface PreparedSetup extends SetupPlan {
  /** The folder, absolute. */
  path: string;
  port: number;
  tls: SetupTls | null;
  /** Through the relay: its control name, and the gateway's URL on its domain. */
  relayed: { control: string; url: string } | null;
}

/**
 * Where setup runs, which decides how to start the gateway again: in a
 * container (the dashboard's second command), through npx, or installed.
 */
export type SetupPlace = "container" | "npx" | "installed";

/** Where this process runs: `/.dockerenv` is a container, `npm_command=exec` is npx. */
export function placeOf(
  o: { inContainer?: boolean; npx?: boolean } = {},
): SetupPlace {
  if (o.inContainer ?? existsSync("/.dockerenv")) return "container";
  return (o.npx ?? process.env.npm_command === "exec") ? "npx" : "installed";
}

/**
 * How to start the gateway in `dir` again, runnable where setup ran. In a
 * container, the setup page's `docker run -d` serves the volume's config:
 * its second command, or a relayed gateway's only one.
 */
export function startHint(
  dir: string,
  place: SetupPlace,
  relayed = false,
): string {
  if (place === "container") {
    return relayed
      ? "the `docker run -d` command on the setup page"
      : "the second command on the setup page";
  }
  const config = join(dir, "midplane.yaml");
  return place === "npx"
    ? `npx -y midplane@latest gateway --config ${config}`
    : `midplane gateway --config ${config}`;
}

/**
 * The folder must not exist, or be empty (a container's volume). A disk
 * mounted there as it comes, such as a Fly volume or a Kubernetes one on
 * ext4, holds the filesystem's own `lost+found`, which counts as empty.
 */
function checkFolder(
  shown: string,
  path: string,
  place: SetupPlace,
  relayed: boolean,
): void {
  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    if (code === "ENOTDIR") {
      throw new SetupError(`${shown} exists and isn't a folder`);
    }
    throw new SetupError(`can't read ${shown} (${code})`);
  }
  if (entries.includes("midplane.yaml")) {
    throw new SetupError(
      place === "container"
        ? `Already set up: start the gateway with ${startHint(shown, place, relayed)}`
        : `Already set up: start it with \`${startHint(shown, place)}\``,
    );
  }
  if (entries.some((e) => e !== "lost+found")) {
    throw new SetupError(`${shown} isn't empty`);
  }
}

/** Whether a listener could take `port` on `host` now. */
export function portFree(port: number, host: string): Promise<boolean> {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(false));
    server.listen({ port, host, exclusive: true }, () =>
      server.close(() => done(true)),
    );
  });
}

/**
 * The port a gateway on this machine listens on: the one asked for, if it is
 * free, else the first free one of 7433-7442. Checked once: a port taken
 * later fails when the gateway starts, with the listener's error.
 */
export async function choosePort(
  wanted: number | null,
  host = "127.0.0.1",
): Promise<number> {
  if (wanted !== null) {
    if (!(await portFree(wanted, host))) {
      throw new SetupError(
        `port ${wanted} is taken: choose another with --port`,
      );
    }
    return wanted;
  }
  for (let port = SETUP_PORT; port < SETUP_PORT + MACHINE_PORTS; port++) {
    if (await portFree(port, host)) return port;
  }
  throw new SetupError(
    `ports ${SETUP_PORT}-${SETUP_PORT + MACHINE_PORTS - 1} are all taken: choose one with --port`,
  );
}

function readTlsFile(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    throw new SetupError(
      `can't read ${file} (${(err as NodeJS.ErrnoException).code ?? "error"})`,
    );
  }
}

/** Nothing written yet, nothing spent: what a refusal before the questions adds. */
const UNSPENT = "Nothing was written, and the token is unused.";

/**
 * Where the cloud's relay is, as its region's cloud says: refused for a
 * cloud without one (404), naming the flag or variable that sets up at a
 * URL of the operator's own instead.
 */
export async function askRelay(
  cloudUrl: string,
  names: InputNames,
  o: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<RelayInfo> {
  const timeout = AbortSignal.timeout(30_000);
  let res: Response;
  try {
    res = await (o.fetch ?? fetch)(`${cloudUrl}${LINK_API_PREFIX}/relay`, {
      signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout,
    });
  } catch (err) {
    if (o.signal?.aborted) throw new PromptClosed(true);
    throw new SetupError(
      `can't reach Midplane Cloud at ${cloudUrl}: ${(err as Error).message}. ${UNSPENT}`,
    );
  }
  const body = (await res.json().catch(() => null)) as unknown;
  // Stopped, or out of time, while the answer was still arriving.
  if (o.signal?.aborted) throw new PromptClosed(true);
  if (timeout.aborted) {
    throw new SetupError(
      `can't reach Midplane Cloud at ${cloudUrl}: no answer within 30 s. ${UNSPENT}`,
    );
  }
  if (res.status === 404) {
    throw new SetupError(
      `Midplane Cloud at ${cloudUrl} has no relay: set the gateway up at a URL of your own, with ${names.url}. ${UNSPENT}`,
    );
  }
  const info = RelayInfoSchema.safeParse(body);
  if (
    !res.ok ||
    !info.success ||
    info.data.control !== relayControlName(info.data.domain)
  ) {
    throw new SetupError(
      `Midplane Cloud at ${cloudUrl} didn't say where its relay is (${res.status}): try again later. ${UNSPENT}`,
    );
  }
  return info.data;
}

/** Everything checked before the first question. */
export async function prepareSetup(
  plan: SetupPlan,
  o: {
    now?: Date;
    place?: SetupPlace;
    acmeHttpPort?: number;
    /** For the relay's whereabouts: how to ask the cloud, and a stop. */
    fetch?: typeof fetch;
    signal?: AbortSignal;
  } = {},
): Promise<PreparedSetup> {
  const path = resolve(plan.dir);
  checkFolder(plan.dir, path, o.place ?? placeOf(), plan.relay !== null);
  if (plan.relay) {
    // On loopback, as on this machine: agents come through the relay.
    const port = await choosePort(plan.port);
    const relay = await askRelay(plan.cloudUrl, plan.names, o);
    const url = `https://${plan.slug}.${relay.domain}`;
    let host: string | null = null;
    try {
      host = new URL(url).hostname;
    } catch {}
    if (host === null || relaySlugOf(host, relay.domain) !== plan.slug) {
      throw new SetupError(
        `Midplane Cloud at ${plan.cloudUrl} named a relay domain no gateway URL can be on (${relay.domain}). ${UNSPENT}`,
      );
    }
    return {
      ...plan,
      path,
      port,
      tls: { kind: "relayed", directoryUrl: plan.relay.directoryUrl },
      relayed: { control: relay.control, url },
    };
  }
  if (!plan.server) {
    return {
      ...plan,
      path,
      port: await choosePort(plan.port),
      tls: null,
      relayed: null,
    };
  }
  const port = plan.port ?? SETUP_PORT;
  const certificate = plan.server.certificate;
  if (certificate.kind === "acme") {
    // Setup answers the challenge itself, on every interface.
    const httpPort = o.acmeHttpPort ?? ACME_HTTP_PORT;
    if (port === httpPort) {
      throw new SetupError(
        `${plan.names.port} ${port} is where the certificate's challenge is answered: choose another`,
      );
    }
    if (!(await portFree(httpPort, "0.0.0.0"))) {
      throw new SetupError(
        `port ${httpPort} is taken: setup answers the certificate's challenge on it`,
      );
    }
    return {
      ...plan,
      path,
      port,
      tls: { kind: "acme", directoryUrl: certificate.directoryUrl, httpPort },
      relayed: null,
    };
  }
  const dir = resolve(certificate.dir);
  const tls = {
    kind: "files" as const,
    certFile: join(dir, "tls.crt"),
    keyFile: join(dir, "tls.key"),
  };
  const problem = certificateProblem(
    { ...tls, cert: readTlsFile(tls.certFile), key: readTlsFile(tls.keyFile) },
    [new URL(plan.server.url).hostname],
    o.now ?? new Date(),
  );
  if (problem) throw new SetupError(problem);
  return { ...plan, path, port, tls, relayed: null };
}

/** The URL agents reach the gateway at, as `public_urls` lists it. */
export function baseUrlOfSetup(p: PreparedSetup): string {
  const server = p.relayed ?? p.server;
  return server ? server.url : `http://${p.slug}.localhost:${p.port}`;
}

/**
 * How the dashboard names the gateway: its slug, or the host agents reach
 * it at, a server's or its relay host (80 characters at most).
 */
export function gatewayNameOf(p: PreparedSetup): string {
  const server = p.relayed ?? p.server;
  return server ? new URL(server.url).host.slice(0, 80) : p.slug;
}

// ── connection strings ─────────────────────────────────────────────────────

/** Why a role can do more than agents ever should, the worse first. */
export type RoleWarning = "superuser" | "owns_tables";

export type ConnectionTest =
  | {
      ok: true;
      database: string;
      host: string;
      tables: number;
      role: string;
      warning: RoleWarning | null;
    }
  | { ok: false; code: string | null };

export function looksLikeDsn(text: string): boolean {
  if (!/^postgres(ql)?:\/\//i.test(text)) return false;
  try {
    new URL(text);
    return true;
  } catch {
    return false;
  }
}

/** The host a connection string names; never its credentials. */
export function dsnHost(dsn: string): string {
  try {
    const url = new URL(dsn);
    return url.hostname || url.searchParams.get("host") || "localhost";
  } catch {
    return "localhost";
  }
}

/** The database a connection string's path names, if any. */
export function dsnDatabase(dsn: string): string | null {
  try {
    return decodeURIComponent(new URL(dsn).pathname.slice(1)) || null;
  } catch {
    return null;
  }
}

const SYSTEM = new Set(["pg_catalog", "information_schema"]);

/** User tables and views, without partitions: as the policy editor lists them. */
function tableCount(catalog: CatalogSnapshot): number {
  return catalog.relations.filter((r) => !SYSTEM.has(r.schema) && !r.parent)
    .length;
}

// A table's owner may alter or drop it whatever its grants, and its schema's
// owner may drop it (from Postgres 15, `public` belongs to the database's
// owner). So may any member of either, inheriting or not, as it can SET ROLE;
// a superuser is a member of every role.
const ROLE_CHECK = `SELECT r.rolsuper AS superuser,
  EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
      AND (pg_has_role(current_user, c.relowner, 'MEMBER')
        OR pg_has_role(current_user, n.nspowner, 'MEMBER'))
  ) AS owns_tables
FROM pg_roles r WHERE r.rolname = current_user`;

/** What the role can do beyond what agents should; null if the check fails. */
async function roleWarning(
  executor: DatabaseExecutor,
): Promise<RoleWarning | null> {
  try {
    const { rows } = await executor.withReadOnly((client) =>
      client.query<{ superuser: boolean; owns_tables: boolean }>(ROLE_CHECK),
    );
    if (rows[0]?.superuser) return "superuser";
    return rows[0]?.owns_tables ? "owns_tables" : null;
  } catch {
    return null;
  }
}

/**
 * Connect as the gateway will, name the database, and read its catalog in
 * the gateway's own read-only session, with its timeouts; then check the
 * role, in a session of its own, so that a failed check fails nothing. A
 * failure is its code alone.
 */
export async function testConnection(dsn: string): Promise<ConnectionTest> {
  const executor = new DatabaseExecutor(dsn);
  try {
    const { database, role, catalog } = await executor.withReadOnly(
      async (client) => {
        const who = (
          await client.query<{ database: string; role: string }>(
            "SELECT current_database() AS database, current_user AS role",
          )
        ).rows[0];
        return {
          database: who?.database ?? "",
          role: who?.role ?? "",
          catalog: await introspect(client),
        };
      },
    );
    return {
      ok: true,
      database,
      host: dsnHost(dsn),
      tables: tableCount(catalog),
      role,
      warning: await roleWarning(executor),
    };
  } catch (err) {
    return { ok: false, code: errorCode(err) };
  } finally {
    await executor.close().catch(() => {});
  }
}

/**
 * A database id from a database's name: lowercase, `_` for anything an id
 * can't hold, `db_` first unless it starts with a letter, at most 32
 * characters. Null without a name.
 */
export function suggestDatabaseId(name: string | null): string | null {
  if (!name) return null;
  let id = name.toLowerCase().replace(/[^a-z0-9_-]/gu, "_");
  if (!/^[a-z]/.test(id)) id = `db_${id}`;
  return id.slice(0, 32);
}

// ── the questions ──────────────────────────────────────────────────────────

export interface ChosenDatabase {
  id: string;
  dsn: string;
  /** The variable it is in, which the config names instead of writing a file. */
  env?: string;
}

export interface SetupIO {
  prompter: Prompter;
  /** Text for the person: test results, hints and the summary. */
  out: (text: string) => void;
  /** Ends a question or a test, as Ctrl-C; during enrollment, stops waiting. */
  signal?: AbortSignal;
  fetch?: typeof fetch;
  /** In a container, localhost is the container; by default, from /.dockerenv. */
  inContainer?: boolean;
  /** Run through npx; by default, from `npm_command`. */
  npx?: boolean;
  slug?: string;
  now?: Date;
  /** For tests: where the certificate's challenge listens, and how it polls. */
  acme?: { httpPort?: number; polling?: Polling };
}

/** A test that ends at once when setup is stopped. */
export function abortable<T>(p: Promise<T>, signal: AbortSignal | undefined) {
  if (!signal) return p;
  return new Promise<T>((done, fail) => {
    const stop = () => fail(new PromptClosed(true));
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", stop);
        done(v);
      },
      (e) => {
        signal.removeEventListener("abort", stop);
        fail(e);
      },
    );
  });
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The warning for a role that can do more than agents ever should. */
function roleWarningLine(
  role: string,
  database: string,
  warning: RoleWarning,
): string {
  const what =
    warning === "superuser"
      ? `${role} is a superuser`
      : `${role} owns tables in ${database}, or their schema, so Postgres lets it drop them whatever its grants`;
  return `warning: ${what}. Midplane can only narrow what this role may do: give the gateway a role with only what agents should ever be able to do (https://midplane.ai/docs/prepare-database).`;
}

/**
 * What a connection test says, a line each: what it found and any warning
 * about the role, or why it failed. Never the connection string.
 */
export function connectionTestLines(
  test: ConnectionTest,
  dsn: string,
  inContainer: boolean,
): { warn: boolean; text: string }[] {
  if (test.ok) {
    return [
      {
        warn: false,
        text: `ok: database ${test.database} on ${test.host}, ${plural(test.tables, "table")}`,
      },
      ...(test.warning
        ? [
            {
              warn: true,
              text: roleWarningLine(test.role, test.database, test.warning),
            },
          ]
        : []),
    ];
  }
  return [
    { warn: true, text: connectionErrorLine(test.code) },
    ...(inContainer && test.code === "ECONNREFUSED" && isLoopback(dsnHost(dsn))
      ? [
          {
            warn: true,
            text: "Inside the container, localhost is the container: use the database's host on your network.",
          },
        ]
      : []),
  ];
}

/**
 * A connection string, tested, or null to skip. A failed one is asked for
 * again, and `keep` saves it anyway: the gateway then reports the database
 * unreachable until it answers.
 */
async function askConnection(
  io: SetupIO,
  label: string,
): Promise<{ dsn: string; test: ConnectionTest } | null> {
  const inContainer = io.inContainer ?? existsSync("/.dockerenv");
  let failed: { dsn: string; test: ConnectionTest } | null = null;
  for (;;) {
    const hint: string = failed
      ? "Enter to skip, keep to save it anyway"
      : "Enter to skip";
    const answer: string = (
      await io.prompter.ask(`Connection string${label} (${hint}): `, {
        secret: true,
      })
    ).trim();
    if (answer === "") return null;
    if (failed && answer === "keep") return failed;
    if (!looksLikeDsn(answer)) {
      io.out(
        "  that isn't a connection string: postgres://<user>:<password>@<host>:5432/<database>\n",
      );
      continue;
    }
    const test = await abortable(testConnection(answer), io.signal);
    for (const line of connectionTestLines(test, answer, inContainer)) {
      io.out(`  ${line.text}\n`);
    }
    if (test.ok) return { dsn: answer, test };
    failed = { dsn: answer, test };
  }
}

async function askYesNo(
  io: SetupIO,
  question: string,
  yes: boolean,
): Promise<boolean> {
  for (;;) {
    const answer = (await io.prompter.ask(question)).trim().toLowerCase();
    if (answer === "") return yes;
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
  }
}

/**
 * A name for a new database: the one suggested, or one typed. Not one chosen
 * already, nor one named by --database even if skipped: that id is a
 * database the project has, whose policy would then govern this one.
 */
async function askName(
  io: SetupIO,
  got: { dsn: string; test: ConnectionTest },
  chosen: ReadonlySet<string>,
  reserved: ReadonlySet<string>,
): Promise<string> {
  const taken = (id: string) => chosen.has(id) || reserved.has(id);
  const suggested = suggestDatabaseId(
    got.test.ok ? got.test.database : dsnDatabase(got.dsn),
  );
  const fallback = suggested && !taken(suggested) ? suggested : null;
  for (;;) {
    const answer = (
      await io.prompter.ask(
        `Name it in Midplane${fallback ? ` [${fallback}]` : ""}: `,
      )
    ).trim();
    const id = answer || fallback;
    if (!id) {
      io.out("  type a name for it\n");
      continue;
    }
    if (!DatabaseIdSchema.safeParse(id).success) {
      io.out(`  ${ID_RULE}\n`);
    } else if (chosen.has(id)) {
      io.out(`  ${id} is already chosen\n`);
    } else if (reserved.has(id)) {
      io.out(`  ${id} is named by --database; choose another name\n`);
    } else {
      return id;
    }
  }
}

/** The databases to serve: those named with --database, then any added. */
export async function askDatabases(
  plan: SetupPlan,
  io: SetupIO,
): Promise<ChosenDatabase[]> {
  const chosen: ChosenDatabase[] = [];
  for (const id of plan.databases) {
    const got = await askConnection(io, ` for ${id}`);
    if (got) chosen.push({ id, dsn: got.dsn });
  }
  for (;;) {
    const more =
      chosen.length === 0
        ? await askYesNo(io, "Add a database? [Y/n] ", true)
        : await askYesNo(io, "Add another? [y/N] ", false);
    if (!more) break;
    const got = await askConnection(io, "");
    if (!got) continue;
    const id = await askName(
      io,
      got,
      new Set(chosen.map((d) => d.id)),
      new Set(plan.databases),
    );
    chosen.push({ id, dsn: got.dsn });
  }
  if (chosen.length === 0) {
    throw new SetupError(
      "No database chosen: a gateway serves at least one. Nothing was written, and the token is unused.",
    );
  }
  return chosen;
}

// ── the config, written, and enrollment ───────────────────────────────────

/** A value as a YAML flow scalar: plain when it can be, else quoted. */
const yamlValue = (v: string) =>
  /^[A-Za-z0-9._~:/%-]+$/.test(v) ? v : JSON.stringify(v);

/** An id as a YAML key; the three YAML reads as something else are quoted. */
const yamlKey = (id: string) =>
  /^(null|true|false)$/.test(id) ? JSON.stringify(id) : id;

/**
 * The `tls` line: files, absolute, or ACME, with only what isn't a default;
 * through the relay, nothing binds a challenge port.
 */
function tlsYaml(tls: SetupTls): string {
  if (tls.kind === "files") {
    return `tls: { cert_file: ${yamlValue(tls.certFile)}, key_file: ${yamlValue(tls.keyFile)} }`;
  }
  const acme = [
    ...(tls.kind === "acme" && tls.httpPort !== ACME_HTTP_PORT
      ? [`http_port: ${tls.httpPort}`]
      : []),
    ...(tls.directoryUrl !== LETS_ENCRYPT
      ? [`directory_url: ${yamlValue(tls.directoryUrl)}`]
      : []),
  ];
  return `tls: { acme: {${acme.length > 0 ? ` ${acme.join(", ")} ` : ""}} }`;
}

/**
 * The gateway's `midplane.yaml`, every path in it relative to it but TLS's.
 * A connection string is a file in `secrets/`, or the variable `dsnEnv`
 * names for its database. A relayed gateway (`relay`, the control name)
 * listens on loopback, with its certificate from ACME through the relay.
 */
export function setupYaml(o: {
  cloudUrl: string;
  name: string;
  baseUrl: string;
  port: number;
  tls: SetupTls | null;
  relay?: string | null;
  databases: readonly string[];
  dsnEnv?: Readonly<Record<string, string>>;
  /** What wrote it, for its first line. */
  by?: string;
}): string {
  const dsn = (id: string) => {
    const env = o.dsnEnv?.[id];
    return env ? `{ env: ${yamlValue(env)} }` : `{ file: secrets/${id}.dsn }`;
  };
  return [
    `# midplane.yaml, written by ${o.by ?? "`midplane setup`"}`,
    o.relay
      ? `listen: { host: 127.0.0.1, port: ${o.port} }`
      : o.tls
        ? `listen: { host: 0.0.0.0, port: ${o.port} }`
        : `listen: { port: ${o.port} }`,
    ...(o.relay ? [`relay: { control: ${yamlValue(o.relay)} }`] : []),
    `public_urls: [${yamlValue(o.baseUrl)}]`,
    ...(o.tls ? [tlsYaml(o.tls)] : []),
    "audit: { file: audit.db }",
    "mask_salt: { file: secrets/mask-salt }",
    "link:",
    `  cloud_url: ${yamlValue(o.cloudUrl)}`,
    `  name: ${yamlValue(o.name)}`,
    "  identity: { file: identity.json }",
    "databases:",
    ...o.databases.map((id) => `  ${yamlKey(id)}: { dsn: ${dsn(id)} }`),
    "",
  ].join("\n");
}

const MAYBE_ENROLLED = (name: string) =>
  `The cloud may have enrolled this gateway: if the Gateways page lists \`${name}\`, revoke it, then run setup again with a new token.`;

/** An ACME failure as setup says it: the sentence, then what the authority said. */
function acmeFailureText(err: AcmeError, ca: string): string {
  const said = err.problem
    ? `\n  ${ca} said: ${err.problem.detail || "nothing more"} (${err.kind})`
    : "";
  return `${err.message}${said}\nSetup removed the files it wrote; the token is unused.`;
}

/**
 * Get a server's certificate into `<folder>/acme`, answering the challenge
 * on every interface meanwhile. Throws what setup says.
 */
async function getCertificate(
  p: PreparedSetup,
  tls: Extract<SetupTls, { kind: "acme" }>,
  io: Partial<Pick<SetupIO, "out" | "signal" | "acme">>,
): Promise<void> {
  const host = new URL(baseUrlOfSetup(p)).hostname;
  const ca = authorityName(tls.directoryUrl);
  io.out?.(`Getting a certificate for ${host} from ${ca}…\n`);
  const tokens = new ChallengeTokens();
  let listener: ChallengeListener | null = null;
  try {
    listener = await listenForChallenges(tls.httpPort, tokens);
    const issued = await obtainCertificate({
      directoryUrl: tls.directoryUrl,
      names: [host],
      dir: join(p.path, "acme"),
      challenges: tokens,
      httpPort: tls.httpPort,
      ...(io.signal ? { signal: io.signal } : {}),
      ...(io.acme?.polling ? { polling: io.acme.polling } : {}),
    });
    const until = new X509Certificate(issued.cert).validToDate;
    io.out?.(`  ok: valid until ${until.toISOString().slice(0, 10)}\n`);
  } catch (err) {
    if (io.signal?.aborted) throw new PromptClosed(true);
    if (err instanceof AcmeError) {
      throw new SetupError(acmeFailureText(err, ca));
    }
    throw new SetupError(
      `can't get a certificate (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})\nSetup removed the files it wrote; the token is unused.`,
    );
  } finally {
    await listener?.close();
  }
}

/**
 * Write the folder (made 0700, `secrets/` 0700, each secret 0600), get a
 * server's ACME certificate, enroll naming every database, and write the
 * identity (0600) and then the config (0644): a folder with a config is set
 * up. Anything it wrote is removed if any of it fails. A database whose
 * connection string is in a variable gets no file; `env` holds those
 * variables, to check that the gateway starts from the config. With
 * `certificateAtStart`, the gateway gets the ACME certificate as it first
 * starts, after enrolling, so a token the cloud refuses orders none. A
 * relayed gateway always does: its challenge comes through the work
 * connections its identity opens.
 */
export async function writeAndEnroll(
  p: PreparedSetup,
  chosen: readonly ChosenDatabase[],
  io: Partial<Pick<SetupIO, "fetch" | "signal" | "out" | "acme">> & {
    env?: NodeJS.ProcessEnv;
    by?: string;
    certificateAtStart?: boolean;
  } = {},
): Promise<{ configPath: string; enrollment: Enrollment }> {
  const files: string[] = [];
  /** Folders setup made, deepest first. */
  const folders: string[] = [];
  const undo = () => {
    for (const f of files.reverse()) {
      try {
        unlinkSync(f);
      } catch {}
    }
    for (const d of folders) {
      try {
        rmdirSync(d);
      } catch {}
    }
  };
  /** A new file, never an existing one, kept for `undo` once it exists. */
  const write = (path: string, text: string, mode: number) => {
    const fd = openSync(path, "wx", mode);
    files.push(path);
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
  };
  const name = gatewayNameOf(p);
  const configPath = join(p.path, "midplane.yaml");
  const config = setupYaml({
    cloudUrl: p.cloudUrl,
    name,
    baseUrl: baseUrlOfSetup(p),
    port: p.port,
    tls: p.tls,
    relay: p.relayed?.control ?? null,
    databases: chosen.map((d) => d.id),
    dsnEnv: Object.fromEntries(
      chosen.flatMap((d) => (d.env ? [[d.id, d.env]] : [])),
    ),
    ...(io.by ? { by: io.by } : {}),
  });

  try {
    // Closed to other users, audit file and all; a volume keeps its own mode.
    const top = mkdirSync(p.path, { recursive: true, mode: 0o700 });
    if (top !== undefined) {
      for (let d = p.path; ; d = dirname(d)) {
        folders.push(d);
        if (d === resolve(top) || d === dirname(d)) break;
      }
    }
    const secrets = join(p.path, "secrets");
    mkdirSync(secrets, { mode: 0o700 });
    folders.unshift(secrets);
    write(join(secrets, "mask-salt"), randomBytes(32).toString("hex"), 0o600);
    for (const db of chosen) {
      if (!db.env) write(join(secrets, `${db.id}.dsn`), db.dsn, 0o600);
    }
  } catch (err) {
    undo();
    throw new SetupError(
      `can't write the gateway's files in ${p.dir} (${(err as NodeJS.ErrnoException).code ?? "error"})`,
    );
  }
  if (io.signal?.aborted) {
    undo();
    throw new PromptClosed(true);
  }
  // The gateway must start from what setup wrote, before any token or
  // certificate is spent on it.
  try {
    parseLinkedConfig(config, configPath, io.env ?? {});
  } catch (err) {
    undo();
    if (!(err instanceof ConfigError)) throw err;
    throw new SetupError(
      `the gateway wouldn't start from this config (${err.message}); setup removed the files it wrote and the token is unused`,
    );
  }

  if (p.tls?.kind === "acme" && !io.certificateAtStart) {
    // Its own folder, closed like `secrets/`; whatever ACME kept in it goes too.
    const acme = join(p.path, "acme");
    try {
      mkdirSync(acme, { mode: 0o700 });
    } catch (err) {
      undo();
      throw new SetupError(
        `can't write the gateway's files in ${p.dir} (${(err as NodeJS.ErrnoException).code ?? "error"})`,
      );
    }
    folders.unshift(acme);
    for (const f of Object.values(ACME_FILES)) {
      files.push(join(acme, f), join(acme, `${f}.tmp`));
    }
    try {
      await getCertificate(p, p.tls, io);
    } catch (err) {
      undo();
      throw err;
    }
  }

  let enrollment: Enrollment;
  try {
    enrollment = await enroll({
      cloudUrl: p.cloudUrl,
      token: p.token,
      resources: [resourceOf(baseUrlOfSetup(p))],
      name,
      databases: chosen.map((d) => d.id),
      ...(io.signal ? { signal: io.signal } : {}),
      ...(io.fetch ? { fetch: io.fetch } : {}),
    });
  } catch (err) {
    undo();
    const maybe = !(err instanceof EnrollmentError) || err.maybeEnrolled;
    throw new SetupError(
      `${(err as Error).message}\n${maybe ? MAYBE_ENROLLED(name) : "Setup removed the files it wrote."}`,
    );
  }
  try {
    write(
      join(p.path, "identity.json"),
      identityText(enrollment.identity),
      0o600,
    );
    write(configPath, config, 0o644);
  } catch {
    undo();
    throw new SetupError(
      `Enrolled as \`${name}\`, but identity.json or midplane.yaml couldn't be written: revoke it on the Gateways page and run setup again with a new token.`,
    );
  }
  return { configPath, enrollment };
}

/** The project's name as the cloud says it, without control characters. */
export function projectNameOf(enrollment: Enrollment): string {
  return enrollment.projectName?.replace(/\p{Cc}/gu, "") || "the project";
}

/** Where agents reach a relayed gateway, once it has its certificate: setup's last line. */
export function relayedLine(mcp: string): string {
  return `Agents reach it at ${mcp}, through Midplane's relay, once the gateway has its certificate.`;
}

/**
 * What setup did, the line that adds the gateway to Claude Code, and how to
 * start it; for a relayed gateway, then where agents reach it.
 */
export function setupSummary(
  p: PreparedSetup,
  chosen: readonly ChosenDatabase[],
  enrollment: Enrollment,
  place: SetupPlace = "installed",
): string {
  const project = projectNameOf(enrollment);
  const ids = chosen.map((d) => d.id);
  const added = enrollment.databasesAdded;
  const lines = ["", `Enrolled gateway ${gatewayNameOf(p)} in ${project}.`];
  if (added === null) {
    lines.push(`  Serves: ${ids.join(", ")}.`);
  } else {
    const kept = ids.filter((id) => !added.includes(id));
    if (added.length > 0) {
      lines.push(
        `  Added to ${project}: ${added.join(", ")}. Nothing in ${added.length === 1 ? "it" : "them"} is readable until a policy is published.`,
      );
    }
    if (kept.length > 0) {
      lines.push(`  Already in ${project}: ${kept.join(", ")}.`);
    }
  }
  const mcp = resourceOf(baseUrlOfSetup(p));
  const relayed = Boolean(p.relayed);
  lines.push(
    ...(relayed ? [] : [`  Agents reach it at ${mcp}`]),
    "",
    "Add it to Claude Code:",
    `  claude mcp add --transport http midplane ${mcp}`,
    "",
    ...(place === "container"
      ? [`Start the gateway with ${startHint(p.dir, place, relayed)}.`]
      : ["Start it again with:", `  ${startHint(p.dir, place)}`]),
    "",
    ...(relayed ? [relayedLine(mcp), ""] : []),
  );
  return lines.join("\n");
}

export interface SetupResult {
  configPath: string;
  /** Serve now, unless --no-start. */
  start: boolean;
  enrollment: Enrollment;
}

/** Check, ask, test, write and enroll; the caller serves. */
export async function runSetup(
  flags: SetupFlags,
  io: SetupIO,
): Promise<SetupResult> {
  const place = placeOf(io);
  const p = await prepareSetup(planSetup(flags, io.slug), {
    place,
    ...(io.now ? { now: io.now } : {}),
    ...(io.acme?.httpPort !== undefined
      ? { acmeHttpPort: io.acme.httpPort }
      : {}),
    ...(io.fetch ? { fetch: io.fetch } : {}),
    ...(io.signal ? { signal: io.signal } : {}),
  });
  io.out(
    [
      `Setting up gateway ${gatewayNameOf(p)} in ${p.dir}, at ${baseUrlOfSetup(p)}${p.relayed ? `, through Midplane's relay (${p.relayed.control})` : ""}.`,
      `Connection strings are tested here and saved only in ${join(p.dir, "secrets")}: they never reach Midplane Cloud.`,
      "",
    ].join("\n"),
  );
  const chosen = await askDatabases(p, io);
  const { configPath, enrollment } = await writeAndEnroll(p, chosen, io);
  io.out(setupSummary(p, chosen, enrollment, place));
  return { configPath, start: p.start, enrollment };
}
