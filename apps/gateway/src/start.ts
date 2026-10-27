// `midplane start`: the image's default command. It serves the config
// mounted at /etc/midplane/midplane.yaml, else the one a volume at
// /var/lib/midplane was set up with. Else, with an enrollment token in the
// environment, it sets the gateway up from the environment into that volume,
// as `midplane setup` does from its answers, and then serves. So one
// detached `docker run --env-file …`, or a platform's secrets, is the whole
// setup, and the same container restarted serves what it wrote.
//
// The environment names the cloud, the token, the gateway's URL (whose
// certificate the gateway gets itself, with ACME, as it first starts, so a
// token the cloud refuses orders none) and a connection string per
// database, `MIDPLANE_DSN_<ID>`. The config names each one's variable,
// so the connection string stays in the environment: it is never written to
// the volume, logged or sent to the cloud. Setup says what it does in JSON
// log lines, as the gateway does, and an error is the last one.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseIdSchema } from "@midplane/protocol";
import type { Logger } from "./log.ts";
import {
  abortable,
  baseUrlOfSetup,
  type ChosenDatabase,
  connectionTestLines,
  gatewayNameOf,
  type InputNames,
  looksLikeDsn,
  placeOf,
  planSetup,
  prepareSetup,
  SetupError,
  type SetupFlags,
  testConnection,
  writeAndEnroll,
} from "./setup.ts";
import { resourceOf } from "./urls.ts";

/** Where the image reads a config mounted into it. */
export const IMAGE_CONFIG = "/etc/midplane/midplane.yaml";
/** The image's working directory, on a volume: where setup writes. */
export const IMAGE_DATA = "/var/lib/midplane";

/** The variables `start` sets up from. */
export const ENV = {
  cloud: "MIDPLANE_CLOUD_URL",
  token: "MIDPLANE_ENROLLMENT_TOKEN",
  url: "MIDPLANE_URL",
  port: "MIDPLANE_PORT",
  acmeDirectory: "MIDPLANE_ACME_DIRECTORY",
} as const;

/** `MIDPLANE_DSN_SHOP` holds the connection string of the database `shop`. */
export const DSN_PREFIX = "MIDPLANE_DSN_";

const ENV_NAMES: InputNames = {
  cloud: ENV.cloud,
  token: ENV.token,
  url: ENV.url,
  // The certificate is always automatic.
  acme: null,
  acmeDirectory: ENV.acmeDirectory,
  port: ENV.port,
};

// ── what to start from ─────────────────────────────────────────────────────

export type StartFrom =
  | { kind: "config"; path: string }
  | { kind: "environment"; dir: string };

/**
 * A mounted config, else the volume's, else the environment's answers when
 * it holds a token. Without any of them there is nothing to serve.
 */
export function chooseStart(o: {
  config: string;
  dir: string;
  env: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}): StartFrom {
  const exists = o.exists ?? existsSync;
  if (exists(o.config)) return { kind: "config", path: o.config };
  const volume = join(o.dir, "midplane.yaml");
  if (exists(volume)) return { kind: "config", path: volume };
  if (o.env[ENV.token]?.trim()) return { kind: "environment", dir: o.dir };
  throw new SetupError(
    `no config: mount one at ${o.config}, or set ${ENV.token} from your project's setup page`,
  );
}

// ── the environment ────────────────────────────────────────────────────────

/** A database to set up: its id, the variable its connection string is in, and the string. */
export interface EnvDatabase {
  id: string;
  variable: string;
  dsn: string;
}

const WHAT: Record<string, string> = {
  [ENV.cloud]: "Midplane Cloud's URL, such as https://eu.app.midplane.ai",
  [ENV.token]: "the enrollment token from your project's setup page",
  [ENV.url]:
    "the URL agents reach the gateway at, such as https://midplane.example.com",
};

/**
 * Setup's flags and databases from the environment, checked before anything
 * is written: every variable it needs, and a connection string per
 * database. A refusal names each variable, never a connection string.
 */
export function readSetupEnv(
  env: NodeJS.ProcessEnv,
  dir: string,
): { flags: SetupFlags; databases: EnvDatabase[] } {
  const value = (name: string) => env[name]?.trim() || undefined;
  const problems: string[] = [];
  for (const name of [ENV.cloud, ENV.token, ENV.url]) {
    if (!value(name)) problems.push(`${name} is not set: ${WHAT[name]}`);
  }
  const databases: EnvDatabase[] = [];
  /** The variable naming each id. */
  const seen = new Map<string, string>();
  const variables = Object.keys(env)
    .filter((name) => name.startsWith(DSN_PREFIX))
    .sort();
  for (const variable of variables) {
    // The variable's name, lowercased, is the id: no `-` in a variable.
    const id = variable.slice(DSN_PREFIX.length).toLowerCase();
    const dsn = env[variable] ?? "";
    const twin = seen.get(id);
    seen.set(id, variable);
    if (!DatabaseIdSchema.safeParse(id).success) {
      problems.push(
        `${variable}: after ${DSN_PREFIX} comes the database's id, which starts with a letter and has up to 32 letters, digits or _`,
      );
    } else if (twin) {
      problems.push(`${twin} and ${variable} both name ${id}`);
    } else if (dsn === "") {
      problems.push(`${variable} is empty`);
    } else if (!looksLikeDsn(dsn)) {
      problems.push(
        `${variable} isn't a connection string: postgres://<user>:<password>@<host>:5432/<database>`,
      );
    } else {
      databases.push({ id, variable, dsn });
    }
  }
  if (variables.length === 0) {
    problems.push(
      `${DSN_PREFIX}<ID> is not set: one per database, its connection string, such as ${DSN_PREFIX}SHOP for shop`,
    );
  }
  if (problems.length > 0) {
    throw new SetupError(
      `${problems.join("; ")}. Nothing was written, and the token is unused.`,
    );
  }
  const port = value(ENV.port);
  const directory = value(ENV.acmeDirectory);
  return {
    flags: {
      cloud: value(ENV.cloud),
      token: value(ENV.token),
      url: value(ENV.url),
      acme: true,
      ...(directory ? { "acme-directory": directory } : {}),
      ...(port ? { port } : {}),
      dir,
    },
    databases,
  };
}

// ── setting up ─────────────────────────────────────────────────────────────

export interface EnvSetupOptions {
  /** Where to write: the image's volume. */
  dir: string;
  log: Logger;
  /** Stops setup, which then removes what it wrote. */
  signal?: AbortSignal;
  fetch?: typeof fetch;
  /** In a container, localhost is the container; by default, from /.dockerenv. */
  inContainer?: boolean;
  slug?: string;
  /** For tests: where the certificate's challenge listens. */
  acme?: { httpPort?: number };
}

/**
 * Set the gateway up from the environment into `dir`, as setup does: check
 * every variable and the folder, test each connection string (one that
 * fails is kept, and the gateway reports it unreachable), write and enroll.
 * The gateway gets its certificate as it starts: a certificate it can't get
 * then is tried again at each start, without a new token. Returns the
 * config's path.
 */
export async function setupFromEnv(
  env: NodeJS.ProcessEnv,
  o: EnvSetupOptions,
): Promise<string> {
  const { flags, databases } = readSetupEnv(env, o.dir);
  const p = await prepareSetup(planSetup(flags, o.slug, ENV_NAMES), {
    place: placeOf(o),
    ...(o.acme?.httpPort !== undefined
      ? { acmeHttpPort: o.acme.httpPort }
      : {}),
  });
  const name = gatewayNameOf(p);
  o.log({
    level: "info",
    msg: `setting up gateway ${name} from the environment, in ${p.dir}: each connection string stays in its variable`,
    url: baseUrlOfSetup(p),
    databases: databases.map((d) => d.id),
  });

  const inContainer = o.inContainer ?? existsSync("/.dockerenv");
  const chosen: ChosenDatabase[] = [];
  for (const db of databases) {
    const test = await abortable(testConnection(db.dsn), o.signal);
    for (const line of connectionTestLines(test, db.dsn, inContainer)) {
      o.log({
        level: line.warn ? "warn" : "info",
        msg: line.text,
        database: db.id,
      });
    }
    chosen.push({ id: db.id, dsn: db.dsn, env: db.variable });
  }

  const { configPath, enrollment } = await writeAndEnroll(p, chosen, {
    certificateAtStart: true,
    // Only the variables the config names: it must load from them alone.
    env: Object.fromEntries(databases.map((d) => [d.variable, d.dsn])),
    by: "`midplane start`, from the environment",
    ...(o.signal ? { signal: o.signal } : {}),
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });

  const project =
    enrollment.projectName?.replace(/\p{Cc}/gu, "") || "the project";
  const added = enrollment.databasesAdded;
  o.log({
    level: "info",
    msg: `enrolled gateway ${name} in ${project}${
      added && added.length > 0
        ? `; added ${added.join(", ")}, where nothing is readable until a policy is published`
        : ""
    }`,
    mcp_url: resourceOf(baseUrlOfSetup(p)),
    config: configPath,
  });
  return configPath;
}

export interface StartOptions extends Omit<EnvSetupOptions, "dir"> {
  /** A mounted config, served if it exists. */
  config: string;
  /** The volume: its config is served, or setup writes there. */
  dir: string;
  env: NodeJS.ProcessEnv;
}

/** The config `start` serves: the mounted one, the volume's, or one set up from the environment now. */
export async function startConfig(o: StartOptions): Promise<string> {
  const from = chooseStart(o);
  if (from.kind === "config") {
    o.log({
      level: "info",
      msg: "starting from the config",
      config: from.path,
    });
    return from.path;
  }
  return setupFromEnv(o.env, o);
}
