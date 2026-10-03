#!/usr/bin/env node
// midplane: the gateway command.
//
//   midplane setup --cloud <url> --token <mpe1_…> [--database <id>]...
//                  [--url <https://…>] [--tls-dir <dir>] [--port <n>]
//                  [--dir <dir>] [--no-start]
//                                                      ask for, test and enroll each
//                                                      database, write the folder, serve
//   midplane gateway --config midplane.yaml            serve, linked to Midplane Cloud
//   midplane enroll --config midplane.yaml [--out <file>]
//                                                      enroll once and print the identity
//   midplane local --config midplane.yaml [--stdio]   serve, unlinked from the cloud
//   midplane keygen --out <dir>                        a local signing key pair
//   midplane token --config midplane.yaml --key <signing-key.json> --sub <who>
//                  [--database <id>] [--access read|write] [--ttl <seconds>]
//   midplane audit export (--config midplane.yaml | --audit <file>)
//                  [--out <file>] [--since <seq>]
//   midplane audit verify (--config midplane.yaml | --audit <file> | --file <export>)
//                  [--checkpoints <cloud export>]
//   midplane --version

import { randomUUID } from "node:crypto";
import { createWriteStream, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { parseArgs } from "node:util";
import { loadParser } from "@midplane/core";
import {
  describeVerify,
  exportAudit,
  readCheckpoints,
  verifyAuditExport,
  verifyAuditFile,
} from "./audit-cli.ts";
import { generateSigningKey, mintToken } from "./auth.ts";
import {
  auditFileOf,
  baseUrlOf,
  ConfigError,
  loadConfig,
  loadLinkedConfig,
} from "./config.ts";
import { MCP_PATH } from "./http.ts";
import { writeIdentity } from "./identity.ts";
import { openPrompter, PromptClosed } from "./prompt.ts";
import {
  enrollOnly,
  log,
  type RunningGateway,
  startLinked,
  startLocal,
  startLocalStdio,
} from "./server.ts";
import { runSetup, SetupError, type SetupFlags } from "./setup.ts";
import { SERVER_VERSION } from "./tools.ts";

const USAGE = `usage:
  midplane setup --cloud <url> --token <mpe1_…> [--database <id>]... [--url <https://…>] [--tls-dir <dir>] [--port <n>] [--dir <dir>] [--no-start]
  midplane gateway --config <file>
  midplane enroll --config <file> [--out <file>]
  midplane local --config <file> [--stdio]
  midplane keygen --out <dir>
  midplane token --config <file> --key <signing-key.json> --sub <who> [--database <id>] [--access read|write] [--ttl <seconds>]
  midplane audit export (--config <file> | --audit <file>) [--out <file>] [--since <seq>]
  midplane audit verify (--config <file> | --audit <file> | --file <export>) [--checkpoints <cloud export>]
  midplane --version`;

/** node:sqlite's text-truncation bug is fixed from 24.16. */
const MIN_NODE = [24, 16] as const;

function nodeTooOld(version = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1]);
}

function serveUntilSignal(running: RunningGateway): void {
  const stop = async () => {
    await running.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

/**
 * `midplane setup`: its own flags, questions on the terminal and plain
 * sentences, not log lines. Ctrl-C, SIGTERM or the end of input stops it,
 * and it removes whatever it wrote.
 */
async function setup(args: string[]): Promise<number> {
  let flags: SetupFlags;
  try {
    flags = parseArgs({
      args,
      options: {
        cloud: { type: "string" },
        token: { type: "string" },
        database: { type: "string", multiple: true },
        url: { type: "string" },
        "tls-dir": { type: "string" },
        port: { type: "string" },
        dir: { type: "string" },
        "no-start": { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n${USAGE}\n`);
    return 2;
  }
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const prompter = openPrompter({ signal: abort.signal, onInterrupt: stop });
  let result: Awaited<ReturnType<typeof runSetup>>;
  try {
    result = await runSetup(flags, {
      prompter,
      out: (text) => process.stdout.write(text),
      signal: abort.signal,
    });
  } catch (err) {
    if (err instanceof PromptClosed) {
      process.stderr.write(
        `\n${err.interrupted ? "Stopped" : "The input ended"} before setup wrote anything; the token is unused.\n`,
      );
      return err.interrupted ? 130 : 1;
    }
    if (err instanceof SetupError || err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      // Stopped during enrollment: the request was cut short.
      return abort.signal.aborted ? 130 : 1;
    }
    throw err;
  } finally {
    prompter.close();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  if (!result.start) return 0;
  const config = loadLinkedConfig(result.configPath);
  await loadParser();
  serveUntilSignal(await startLinked(config));
  return -1;
}

async function main(argv: string[]): Promise<number> {
  if (nodeTooOld()) {
    process.stderr.write(
      `midplane needs Node ${MIN_NODE.join(".")} or newer; this is Node ${process.versions.node}.\n`,
    );
    return 1;
  }
  const [command, ...args] = argv;
  if (command === "--version" || command === "version") {
    process.stdout.write(`midplane ${SERVER_VERSION}\n`);
    return 0;
  }
  if (command === "setup") return setup(args);
  // `midplane audit <export|verify>` takes its subcommand first.
  const sub = command === "audit" ? args[0] : undefined;
  const rest = command === "audit" ? args.slice(1) : args;
  const { values } = parseArgs({
    args: rest,
    options: {
      config: { type: "string" },
      stdio: { type: "boolean", default: false },
      out: { type: "string" },
      key: { type: "string" },
      sub: { type: "string" },
      database: { type: "string" },
      access: { type: "string", default: "read" },
      ttl: { type: "string", default: "3600" },
      audit: { type: "string" },
      file: { type: "string" },
      since: { type: "string" },
      checkpoints: { type: "string" },
    },
    strict: true,
  });

  const auditFile = () =>
    values.audit ?? (values.config ? auditFileOf(values.config) : null);

  switch (command) {
    case "audit": {
      if (sub === "export") {
        const file = auditFile();
        if (!file) break;
        const since = values.since ? Number.parseInt(values.since, 10) : 0;
        if (!Number.isSafeInteger(since) || since < 0) break;
        const out = values.out
          ? createWriteStream(values.out, { flags: "wx", mode: 0o600 })
          : process.stdout;
        const { events } = await exportAudit({ file, out, since });
        if (values.out) {
          out.end();
          await finished(out);
        } else {
          // Exiting drops what a pipe hasn't taken yet; wait for it.
          await new Promise<void>((resolve) =>
            process.stdout.write("", () => resolve()),
          );
        }
        process.stderr.write(
          `exported ${events} audit events${values.out ? ` to ${values.out}` : ""}\n`,
        );
        return 0;
      }
      if (sub === "verify") {
        const checkpoints = values.checkpoints
          ? await readCheckpoints(values.checkpoints)
          : null;
        let result: Awaited<ReturnType<typeof verifyAuditFile>>;
        if (values.file) {
          result = await verifyAuditExport(values.file, checkpoints);
        } else {
          const file = auditFile();
          if (!file) break;
          result = await verifyAuditFile(file, checkpoints);
        }
        const line = describeVerify(result);
        (result.check.ok ? process.stdout : process.stderr).write(`${line}\n`);
        return result.check.ok ? 0 : 1;
      }
      break;
    }
    case "gateway": {
      if (!values.config) break;
      const config = loadLinkedConfig(values.config);
      await loadParser();
      serveUntilSignal(await startLinked(config));
      return -1;
    }
    case "enroll": {
      if (!values.config) break;
      const config = loadLinkedConfig(values.config);
      const identity = await enrollOnly(config);
      if (values.out) {
        writeIdentity(values.out, identity);
        process.stderr.write(
          `enrolled gateway ${identity.gateway_id}; wrote its identity to ${values.out} (keep it secret)\n`,
        );
      } else {
        process.stdout.write(`${JSON.stringify(identity)}\n`);
        process.stderr.write(
          `enrolled gateway ${identity.gateway_id}; keep the identity above secret, e.g. in the variable link.identity names\n`,
        );
      }
      return 0;
    }
    case "local": {
      if (!values.config) break;
      const config = loadConfig(values.config);
      await loadParser();
      if (values.stdio) {
        const token = process.env.MIDPLANE_TOKEN;
        if (!token)
          throw new ConfigError("--stdio needs a token in MIDPLANE_TOKEN");
        await startLocalStdio(config, token);
        return -1;
      }
      serveUntilSignal(await startLocal(config));
      return -1;
    }
    case "keygen": {
      if (!values.out) break;
      const { privateJwk, publicJwk } = await generateSigningKey();
      const priv = join(values.out, "midplane-signing-key.json");
      const pub = join(values.out, "midplane-verify-key.json");
      writeFileSync(priv, `${JSON.stringify(privateJwk, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      writeFileSync(pub, `${JSON.stringify(publicJwk, null, 2)}\n`, {
        flag: "wx",
      });
      process.stdout.write(
        `wrote ${priv} (keep secret) and ${pub} (auth.public_key_file)\n`,
      );
      return 0;
    }
    case "token": {
      if (!values.config || !values.key || !values.sub) break;
      const config = loadConfig(values.config);
      if (values.access !== "read" && values.access !== "write") break;
      const databases = values.database
        ? [values.database]
        : [...config.databases.keys()];
      for (const d of databases) {
        if (!config.databases.has(d))
          throw new ConfigError(`no database "${d}" in the config`);
      }
      const token = await mintToken({
        privateJwk: JSON.parse(readFileSync(values.key, "utf8")),
        issuer: config.auth.issuer,
        audience: `${baseUrlOf(config)}${MCP_PATH}`,
        project: config.project,
        sub: values.sub,
        clientId: "midplane-cli",
        grantId: `local-${randomUUID()}`,
        databases: Object.fromEntries(
          databases.map((d) => [d, values.access as "read" | "write"]),
        ),
        ttlSeconds: Number.parseInt(values.ttl, 10),
        jti: randomUUID(),
      });
      process.stdout.write(`${token}\n`);
      return 0;
    }
  }
  process.stderr.write(`${USAGE}\n`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (err) => {
    log({
      level: "error",
      msg: err instanceof ConfigError ? err.message : String(err),
    });
    process.exit(1);
  },
);
