// The gateway's state directory: the only thing a gateway must persist.
//
//   gateway.key     PKCS#8 PEM, 0600 — the gateway's identity. Written BEFORE
//                   enrollment calls out, so a retry after a lost response
//                   presents the same key and the control plane can answer it.
//   identity.json   what the signed enrollment response established: gateway
//                   id, project, issuer, the pinned bundle key, the version floor.
//   bundle.jws      the newest AUTHENTIC bundle, exact bytes. Not trusted on
//                   load — it is re-verified against the pinned key and floor
//                   every time — so corruption or tampering degrades to "no
//                   policy yet" rather than to a policy nobody signed.
//
// Every write is tmp + fsync + rename, so a crash leaves the old file or the new
// one, never half of either. The directory is 0700.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeSync,
  chmodSync,
} from "node:fs";
import { randomBytes, type KeyObject } from "node:crypto";
import { join } from "node:path";
import {
  generateEd25519KeyPair,
  privateKeyFromPem,
  publicKeyRawFromPrivate,
  type SigningKeyRef,
} from "./protocol.ts";

export interface StoredIdentity {
  v: 1;
  gateway_id: string;
  project_id: string;
  /** The origin this gateway enrolled against. Informational: requests go to
   *  MIDPLANE_CLOUD_URL; tokens and bundles are bound to `issuer`. */
  cloud_url: string;
  issuer: string;
  signing_key: SigningKeyRef;
  min_version: number;
  poll_seconds: number;
  enrolled_at: number;
}

export interface GatewayKey {
  privateKey: KeyObject;
  publicKeyRaw: Buffer;
}

export class GatewayStateDir {
  private constructor(readonly dir: string) {}

  static open(dir: string): GatewayStateDir {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!statSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Not ours to chmod (e.g. a mounted volume root): the files inside still
      // get their own modes.
    }
    return new GatewayStateDir(dir);
  }

  get keyPath(): string {
    return join(this.dir, "gateway.key");
  }
  get identityPath(): string {
    return join(this.dir, "identity.json");
  }
  get bundlePath(): string {
    return join(this.dir, "bundle.jws");
  }

  hasKey(): boolean {
    return existsSync(this.keyPath);
  }

  loadKey(): GatewayKey {
    const privateKey = privateKeyFromPem(readFileSync(this.keyPath, "utf8"));
    return { privateKey, publicKeyRaw: publicKeyRawFromPrivate(privateKey) };
  }

  /** The existing key, or a new one written before anything is sent. */
  loadOrCreateKey(): GatewayKey {
    if (this.hasKey()) return this.loadKey();
    const pair = generateEd25519KeyPair();
    atomicWrite(this.keyPath, pair.privateKeyPem, 0o600);
    return this.loadKey();
  }

  readIdentity(): StoredIdentity | null {
    if (!existsSync(this.identityPath)) return null;
    const raw = JSON.parse(readFileSync(this.identityPath, "utf8")) as unknown;
    if (!isStoredIdentity(raw)) {
      throw new Error(
        `${this.identityPath} is not a valid gateway identity. Delete the state directory to enroll again.`,
      );
    }
    return raw;
  }

  writeIdentity(identity: StoredIdentity): void {
    atomicWrite(this.identityPath, `${JSON.stringify(identity, null, 2)}\n`, 0o600);
  }

  readBundle(): string | null {
    if (!existsSync(this.bundlePath)) return null;
    return readFileSync(this.bundlePath, "utf8");
  }

  writeBundle(jws: string): void {
    atomicWrite(this.bundlePath, jws, 0o600);
  }
}

export function atomicWrite(path: string, data: string, mode: number): void {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "wx", mode);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  // Make the rename itself durable. Best-effort: not every platform lets a
  // directory be opened for fsync.
  try {
    const dirFd = openSync(join(path, ".."), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // ignore
  }
}

function isStoredIdentity(v: unknown): v is StoredIdentity {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  const key = o.signing_key as Record<string, unknown> | undefined;
  return (
    o.v === 1 &&
    typeof o.gateway_id === "string" &&
    typeof o.project_id === "string" &&
    typeof o.cloud_url === "string" &&
    typeof o.issuer === "string" &&
    typeof key === "object" &&
    key !== null &&
    typeof key.kid === "string" &&
    typeof key.x === "string" &&
    Number.isSafeInteger(o.min_version) &&
    Number.isSafeInteger(o.poll_seconds) &&
    Number.isSafeInteger(o.enrolled_at)
  );
}
