// The certificate a TLS listener serves, kept current without a restart.
//
// From ACME (`tls.acme`): the stored one when it covers every name and has
// more than 30 days left, else a new one before the listener starts. A start
// that can't renew a stored one still in date serves it, with a warning, and
// renews later; only a start with no usable certificate fails. Every 12 hours one with 30 days or fewer left is
// renewed; a renewal that fails is logged and tried again at the next check,
// and the current certificate is served meanwhile.
//
// From files (`tls.cert_file`, `tls.key_file`): read again every 10 minutes,
// so a certificate renewed on disk (certbot, a secret manager) is served
// without a restart. A replacement is served only if it is valid: its key
// matches, it is in date, and it covers every public URL host the one served
// covers. Otherwise the old one stays, with a warning.
//
// Either way a new certificate reaches new connections only; open ones keep
// the one they started with.

import { createPrivateKey, type KeyObject, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import {
  AcmeError,
  type ChallengeListener,
  ChallengeTokens,
  listenForChallenges,
  obtainCertificate,
  type Polling,
  readStoredCertificate,
  type StoredCertificate,
} from "./acme.ts";
import { ConfigError, type TlsConfig } from "./config.ts";
import type { Logger } from "./log.ts";

/** A certificate with this many days left, or fewer, is renewed. */
export const RENEW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How often an ACME certificate is checked for renewal. */
export const ACME_CHECK_MS = 12 * 60 * 60 * 1000;
/** How often certificate files are read again. */
export const FILE_CHECK_MS = 10 * 60 * 1000;

/** A host as a certificate names it: without an IPv6 address's brackets. */
const bare = (host: string) => host.replace(/^\[(.*)\]$/, "$1");

function covers(cert: X509Certificate, host: string): boolean {
  const name = bare(host);
  return Boolean(isIP(name) ? cert.checkIP(name) : cert.checkHost(name));
}

/**
 * Why a listener can't serve these hosts with this certificate and key, or
 * null: which file, and what is wrong with it.
 */
export function certificateProblem(
  files: { cert: string; key: string; certFile: string; keyFile: string },
  hosts: readonly string[],
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
  for (const host of hosts) {
    if (!covers(cert, host)) {
      const names = cert.subjectAltName ?? cert.subject.replace(/\n/g, ", ");
      return `the certificate in ${files.certFile} is for ${names}, not ${bare(host)}`;
    }
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

/**
 * Whether a stored ACME certificate must be replaced: there is none, it or
 * its key can't be read or don't match, it doesn't cover every name, or it
 * has 30 days or fewer left.
 */
export function needsCertificate(
  stored: StoredCertificate | null,
  names: readonly string[],
  now: Date,
): boolean {
  if (!stored) return true;
  try {
    const cert = new X509Certificate(stored.cert);
    if (!cert.checkPrivateKey(createPrivateKey(stored.key))) return true;
    if (!names.every((n) => covers(cert, n))) return true;
    return cert.validToDate.getTime() - now.getTime() <= RENEW_DAYS * DAY_MS;
  } catch {
    return true;
  }
}

/** Whether a stored certificate can be served now: its key, every name, in date. */
function servable(
  stored: StoredCertificate | null,
  names: readonly string[],
  now: Date,
): boolean {
  if (!stored) return false;
  try {
    const cert = new X509Certificate(stored.cert);
    return (
      cert.checkPrivateKey(createPrivateKey(stored.key)) &&
      names.every((n) => covers(cert, n)) &&
      cert.validFromDate <= now &&
      now < cert.validToDate
    );
  } catch {
    return false;
  }
}

const validUntil = (cert: string) =>
  new X509Certificate(cert).validToDate.toISOString();

/** An AcmeError's sentence, and the authority's problem, as log fields. */
function failureFields(err: unknown): Record<string, unknown> {
  if (!(err instanceof AcmeError)) return { error: String(err) };
  return {
    error: err.message,
    ...(err.problem
      ? { acme_type: err.problem.type, acme_detail: err.problem.detail }
      : {}),
  };
}

/** Where a new certificate goes: an HTTPS server, for new connections. */
interface SecureServer {
  setSecureContext(options: { key: string; cert: string }): void;
}

export interface Certificates {
  /** The key and certificate chain to serve now. */
  readonly current: StoredCertificate;
  /** Serve every later certificate on this server. */
  attach(server: SecureServer): void;
  /** Renew or reload now, if due: what the timer runs. */
  check(): Promise<void>;
  close(): Promise<void>;
}

export interface CertificateOptions {
  /** For tests: the clock. */
  now?: () => Date;
  /** For tests: how often each kind is checked, and ACME's polling. */
  timing?: { acmeCheckMs?: number; fileCheckMs?: number; polling?: Polling };
}

/**
 * Start serving `tls`: obtain an ACME certificate first if the stored one
 * won't do (a failure throws its AcmeError), then check on a timer.
 * `publicUrls` are the base URLs whose hosts a certificate file must keep
 * covering.
 */
export async function startCertificates(
  tls: TlsConfig,
  publicUrls: readonly string[],
  log: Logger,
  o: CertificateOptions = {},
): Promise<Certificates> {
  const now = o.now ?? (() => new Date());
  // Closing stops a renewal midway.
  const stopping = new AbortController();
  let server: SecureServer | null = null;
  let current: StoredCertificate;
  let check: () => Promise<void>;
  let challenges: ChallengeListener | null = null;

  const serve = (next: StoredCertificate) => {
    current = next;
    server?.setSecureContext({ key: next.key, cert: next.cert });
  };

  if (tls.kind === "acme") {
    const tokens = new ChallengeTokens();
    try {
      challenges = await listenForChallenges(tls.httpPort, tokens);
    } catch (err) {
      throw new ConfigError((err as Error).message);
    }
    const listener = challenges;
    const obtain = () =>
      obtainCertificate({
        directoryUrl: tls.directoryUrl,
        names: tls.names,
        dir: tls.dir,
        challenges: tokens,
        httpPort: listener.port,
        signal: stopping.signal,
        ...(o.timing?.polling ? { polling: o.timing.polling } : {}),
      });
    let stored: StoredCertificate | null;
    try {
      stored = readStoredCertificate(tls.dir);
      if (!stored || needsCertificate(stored, tls.names, now())) {
        const fallback = servable(stored, tls.names, now()) ? stored : null;
        try {
          stored = await obtain();
          log({
            level: "info",
            msg: "certificate obtained",
            names: tls.names,
            valid_until: validUntil(stored.cert),
          });
        } catch (err) {
          // One still in date beats no listener: the timer renews it.
          if (!fallback || stopping.signal.aborted) throw err;
          stored = fallback;
          log({
            level: "warn",
            msg: "certificate renewal failed",
            ...failureFields(err),
            valid_until: validUntil(fallback.cert),
          });
        }
      }
    } catch (err) {
      await listener.close();
      throw err;
    }
    current = stored;
    check = async () => {
      if (!needsCertificate(current, tls.names, now())) return;
      try {
        serve(await obtain());
        log({
          level: "info",
          msg: "certificate renewed",
          names: tls.names,
          valid_until: validUntil(current.cert),
        });
      } catch (err) {
        if (stopping.signal.aborted) return;
        log({
          level: "warn",
          msg: "certificate renewal failed",
          ...failureFields(err),
        });
      }
    };
  } else {
    current = { cert: tls.cert, key: tls.key };
    // The hosts the served certificate covers, which a replacement must
    // too; not a tunnel's, whose certificate is the tunnel's own.
    const hosts = (() => {
      try {
        const cert = new X509Certificate(tls.cert);
        return publicUrls
          .map((u) => new URL(u).hostname)
          .filter((h) => covers(cert, h));
      } catch {
        return [];
      }
    })();
    /**
     * The last refusal logged, by replacement and reason, so each is said
     * once; a replacement is checked again each time, since one not valid
     * yet becomes valid.
     */
    let refused: string | null = null;
    check = async () => {
      let next: StoredCertificate;
      try {
        next = {
          cert: readFileSync(tls.certFile, "utf8"),
          key: readFileSync(tls.keyFile, "utf8"),
        };
      } catch (err) {
        const why = `can't read ${(err as { path?: string }).path ?? "the certificate"} (${(err as NodeJS.ErrnoException).code ?? "error"})`;
        if (why !== refused) {
          refused = why;
          log({ level: "warn", msg: "certificate not reloaded", error: why });
        }
        return;
      }
      if (next.cert === current.cert && next.key === current.key) return;
      const problem = certificateProblem(
        { ...next, certFile: tls.certFile, keyFile: tls.keyFile },
        hosts,
        now(),
      );
      if (problem) {
        const seen = `${next.cert}\n${next.key}\n${problem}`;
        if (seen !== refused) {
          refused = seen;
          log({
            level: "warn",
            msg: "certificate not reloaded",
            error: problem,
          });
        }
        return;
      }
      refused = null;
      serve(next);
      log({
        level: "info",
        msg: "certificate reloaded",
        file: tls.certFile,
        valid_until: validUntil(next.cert),
      });
    };
  }

  // One check at a time: a slow renewal isn't started twice.
  let running: Promise<void> | null = null;
  const checkOnce = () => {
    running ??= check().finally(() => {
      running = null;
    });
    return running;
  };
  const every =
    tls.kind === "acme"
      ? (o.timing?.acmeCheckMs ?? ACME_CHECK_MS)
      : (o.timing?.fileCheckMs ?? FILE_CHECK_MS);
  const timer = setInterval(() => void checkOnce(), every);
  timer.unref();

  return {
    get current() {
      return current;
    },
    attach(s) {
      server = s;
    },
    check: checkOnce,
    async close() {
      clearInterval(timer);
      stopping.abort();
      await running?.catch(() => {});
      await challenges?.close();
    },
  };
}
