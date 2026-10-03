// `midplane setup`: a linked gateway's folder, from a few questions. It asks
// for each database's connection string, tests it (warning of a role that is
// a superuser or owns tables), suggests a name, writes the config and its
// secrets, and enrolls, naming every database so the cloud adds those the
// project lacks. A database added that way has no policy, so nothing in it
// is readable until someone publishes one. Then the gateway serves, as
// `midplane gateway --config <dir>/midplane.yaml` would.
//
// The enrollment token is spent last: the flags, the folder, the port and
// the certificate are checked before the first question, and each
// connection string is tested as it is given. A failure up to and including
// enrollment removes everything setup wrote, and every file is created
// exclusively, so setup never follows or overwrites one. A connection string
// goes nowhere but its own file: not to the terminal, an error or the cloud.

import {
  createPrivateKey,
  type KeyObject,
  randomBytes,
  X509Certificate,
} from "node:crypto";
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
} from "@midplane/protocol";
import { introspect } from "./catalog.ts";
import { isLoopback } from "./config.ts";
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

// Crockford's base32, lowercase: no i, l, o or u to misread.
const SLUG_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** `gw-` and 8 random base32 characters, as the dashboard makes them. */
export function newGatewaySlug(): string {
  // 256 is a multiple of 32, so every character is equally likely.
  return `gw-${Array.from(randomBytes(8), (b) => SLUG_ALPHABET[b & 31]).join("")}`;
}

// ── the flags ──────────────────────────────────────────────────────────────

/** The command line, as `parseArgs` reads it. */
export interface SetupFlags {
  cloud?: string | undefined;
  token?: string | undefined;
  database?: string[] | undefined;
  url?: string | undefined;
  "tls-dir"?: string | undefined;
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
  /** A server: every interface, with TLS, at this origin. */
  server: { url: string; tlsDir: string } | null;
  /** The port asked for, if any. */
  port: number | null;
  /** Where to write, as given. */
  dir: string;
  slug: string;
  start: boolean;
}

/** A server's URL as `public_urls` lists it: the origin, if it can be one. */
function serverOrigin(text: string): string {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new SetupError("--url: enter the full URL, starting with https://");
  }
  if (url.protocol !== "https:") {
    throw new SetupError(
      "--url must start with https://: off this machine the gateway needs TLS",
    );
  }
  if (url.username || url.password) {
    throw new SetupError("--url can't carry credentials");
  }
  if (url.search || url.hash) {
    throw new SetupError("--url can't have a query or fragment");
  }
  if (!/^\/(mcp\/?)?$/.test(url.pathname)) {
    throw new SetupError(
      "--url names the host only: the gateway answers at its root",
    );
  }
  return url.origin;
}

/** Check the flags, without touching the disk or the network. */
export function planSetup(
  flags: SetupFlags,
  slug = newGatewaySlug(),
): SetupPlan {
  if (!flags.cloud || !flags.token) {
    throw new SetupError(
      "setup needs --cloud <url> and --token <mpe1_…>: copy the command from your project's Gateways page",
    );
  }
  if (!EnrollmentTokenSchema.safeParse(flags.token).success) {
    throw new SetupError("--token is not a Midplane enrollment token (mpe1_…)");
  }
  let cloud: URL;
  try {
    cloud = new URL(flags.cloud);
  } catch {
    throw new SetupError(
      "--cloud must be Midplane Cloud's URL, e.g. https://eu.app.midplane.ai",
    );
  }
  if (
    cloud.protocol !== "https:" &&
    !(cloud.protocol === "http:" && isLoopback(cloud.hostname))
  ) {
    throw new SetupError("--cloud must use https (http only on this machine)");
  }
  if (flags.url === undefined && flags["tls-dir"] !== undefined) {
    throw new SetupError("--tls-dir goes with --url");
  }
  const server =
    flags.url === undefined
      ? null
      : {
          url: serverOrigin(flags.url),
          tlsDir: flags["tls-dir"] ?? DEFAULT_TLS_DIR,
        };
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
      throw new SetupError("--port must be a port number, 1 to 65535");
    }
  }
  return {
    cloudUrl: cloud.origin,
    token: flags.token,
    databases,
    server,
    port,
    dir: flags.dir ?? slug,
    slug,
    start: !flags["no-start"],
  };
}

// ── the folder, the port and the certificate ──────────────────────────────

export interface PreparedSetup extends SetupPlan {
  /** The folder, absolute. */
  path: string;
  port: number;
  /** A server's certificate and key files, absolute. */
  tls: { certFile: string; keyFile: string } | null;
}

/** The folder must not exist, or be empty (a container's volume). */
function checkFolder(shown: string, path: string): void {
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
      `Already set up: start it with \`midplane gateway --config ${join(shown, "midplane.yaml")}\``,
    );
  }
  if (entries.length > 0) throw new SetupError(`${shown} isn't empty`);
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

/**
 * Why a server can't serve `host` with this certificate and key, or null:
 * which file, and what is wrong with it.
 */
export function certificateProblem(
  files: { cert: string; key: string; certFile: string; keyFile: string },
  host: string,
  now: Date,
): string | null {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(files.cert);
  } catch {
    return `${files.certFile} isn't a PEM certificate`;
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(files.key);
  } catch {
    return `${files.keyFile} isn't a PEM private key without a passphrase`;
  }
  const name = host.replace(/^\[(.*)\]$/, "$1");
  const covered = isIP(name) ? cert.checkIP(name) : cert.checkHost(name);
  if (!covered) {
    const names = cert.subjectAltName ?? cert.subject.replace(/\n/g, ", ");
    return `the certificate in ${files.certFile} is for ${names}, not ${name}`;
  }
  if (cert.validToDate < now) {
    return `the certificate in ${files.certFile} expired on ${cert.validToDate.toISOString()}`;
  }
  if (cert.validFromDate > now) {
    return `the certificate in ${files.certFile} isn't valid until ${cert.validFromDate.toISOString()}`;
  }
  if (!cert.checkPrivateKey(key)) {
    return `${files.keyFile} isn't the key of the certificate in ${files.certFile}`;
  }
  return null;
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

/** Everything checked before the first question. */
export async function prepareSetup(
  plan: SetupPlan,
  o: { now?: Date } = {},
): Promise<PreparedSetup> {
  const path = resolve(plan.dir);
  checkFolder(plan.dir, path);
  if (!plan.server) {
    return { ...plan, path, port: await choosePort(plan.port), tls: null };
  }
  const dir = resolve(plan.server.tlsDir);
  const tls = {
    certFile: join(dir, "tls.crt"),
    keyFile: join(dir, "tls.key"),
  };
  const problem = certificateProblem(
    { ...tls, cert: readTlsFile(tls.certFile), key: readTlsFile(tls.keyFile) },
    new URL(plan.server.url).hostname,
    o.now ?? new Date(),
  );
  if (problem) throw new SetupError(problem);
  return { ...plan, path, port: plan.port ?? SETUP_PORT, tls };
}

/** The URL agents reach the gateway at, as `public_urls` lists it. */
export function baseUrlOfSetup(p: PreparedSetup): string {
  return p.server ? p.server.url : `http://${p.slug}.localhost:${p.port}`;
}

/** How the dashboard names the gateway: its slug, or a server's host (80 characters at most). */
export function gatewayNameOf(p: PreparedSetup): string {
  return p.server ? new URL(p.server.url).host.slice(0, 80) : p.slug;
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

function looksLikeDsn(text: string): boolean {
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
  slug?: string;
  now?: Date;
}

/** A test that ends at once when setup is stopped. */
function abortable<T>(p: Promise<T>, signal: AbortSignal | undefined) {
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
    if (test.ok) {
      io.out(
        `  ok: database ${test.database} on ${test.host}, ${plural(test.tables, "table")}\n`,
      );
      if (test.warning) {
        io.out(
          `  ${roleWarningLine(test.role, test.database, test.warning)}\n`,
        );
      }
      return { dsn: answer, test };
    }
    io.out(`  ${connectionErrorLine(test.code)}\n`);
    if (
      inContainer &&
      test.code === "ECONNREFUSED" &&
      isLoopback(dsnHost(answer))
    ) {
      io.out(
        "  Inside the container, localhost is the container: use the database's host on your network.\n",
      );
    }
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

/** The gateway's `midplane.yaml`, every path in it relative to it but TLS's. */
export function setupYaml(o: {
  cloudUrl: string;
  name: string;
  baseUrl: string;
  port: number;
  tls: { certFile: string; keyFile: string } | null;
  databases: readonly string[];
}): string {
  return [
    "# midplane.yaml, written by `midplane setup`",
    o.tls
      ? `listen: { host: 0.0.0.0, port: ${o.port} }`
      : `listen: { port: ${o.port} }`,
    `public_urls: [${yamlValue(o.baseUrl)}]`,
    ...(o.tls
      ? [
          `tls: { cert_file: ${yamlValue(o.tls.certFile)}, key_file: ${yamlValue(o.tls.keyFile)} }`,
        ]
      : []),
    "audit: { file: audit.db }",
    "mask_salt: { file: secrets/mask-salt }",
    "link:",
    `  cloud_url: ${yamlValue(o.cloudUrl)}`,
    `  name: ${yamlValue(o.name)}`,
    "  identity: { file: identity.json }",
    "databases:",
    ...o.databases.map(
      (id) => `  ${yamlKey(id)}: { dsn: { file: secrets/${id}.dsn } }`,
    ),
    "",
  ].join("\n");
}

const MAYBE_ENROLLED = (name: string) =>
  `The cloud may have enrolled this gateway: if the Gateways page lists \`${name}\`, revoke it, then run setup again with a new token.`;

/**
 * Write the folder (made 0700, `secrets/` 0700, each secret 0600, the config 0644),
 * enroll naming every database, and write the identity (0600). Anything it
 * wrote is removed if any of it fails.
 */
export async function writeAndEnroll(
  p: PreparedSetup,
  chosen: readonly ChosenDatabase[],
  io: Pick<SetupIO, "fetch" | "signal"> = {},
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
      write(join(secrets, `${db.id}.dsn`), db.dsn, 0o600);
    }
    write(
      configPath,
      setupYaml({
        cloudUrl: p.cloudUrl,
        name,
        baseUrl: baseUrlOfSetup(p),
        port: p.port,
        tls: p.tls,
        databases: chosen.map((d) => d.id),
      }),
      0o644,
    );
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
  } catch {
    undo();
    throw new SetupError(
      `Enrolled as \`${name}\`, but identity.json couldn't be written: revoke it on the Gateways page and run setup again with a new token.`,
    );
  }
  return { configPath, enrollment };
}

/** What setup did, the line that adds the gateway to Claude Code, and how to start it. */
export function setupSummary(
  p: PreparedSetup,
  chosen: readonly ChosenDatabase[],
  enrollment: Enrollment,
): string {
  // The project's name as the cloud says it, without control characters.
  const project =
    enrollment.projectName?.replace(/\p{Cc}/gu, "") || "the project";
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
  lines.push(
    `  Agents reach it at ${mcp}`,
    "",
    "Add it to Claude Code:",
    `  claude mcp add --transport http midplane ${mcp}`,
    "",
    "Start it again with:",
    `  midplane gateway --config ${join(p.dir, "midplane.yaml")}`,
    "",
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
  const p = await prepareSetup(planSetup(flags, io.slug), {
    ...(io.now ? { now: io.now } : {}),
  });
  io.out(
    [
      `Setting up gateway ${gatewayNameOf(p)} in ${p.dir}, at ${baseUrlOfSetup(p)}.`,
      `Connection strings are tested here and saved only in ${join(p.dir, "secrets")}: they never reach Midplane Cloud.`,
      "",
    ].join("\n"),
  );
  const chosen = await askDatabases(p, io);
  const { configPath, enrollment } = await writeAndEnroll(p, chosen, io);
  io.out(setupSummary(p, chosen, enrollment));
  return { configPath, start: p.start, enrollment };
}
