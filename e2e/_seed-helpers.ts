// Shared DB-seeding helpers for live E2E suites.
//
// PR2 of mcp_url_auth_security: connections no longer carry a plaintext
// mcp_token column; the agent-facing token lives in the new mcp_tokens
// table, hashed at rest via HMAC-SHA256(pepper). E2E suites that bypass
// the UI and seed the cloud DB directly need to mint a real token row
// (and capture its plaintext) so the proxy / indexer / spawner pipeline
// resolves it the same way a Server-Action-created connection would.
//
// Trust posture: pepper is read from the env via loadPepperFromKms.
// Tests run against MIDPLANE_KMS_MODE=env with
// MIDPLANE_TOKEN_PEPPER_<REGION>_V1 set by .env.local — same shape as
// dev. Anyone running E2E against a real KMS-mode deploy needs the IAM
// scoping set up first (out of scope for this helper).

import { ulid } from "ulid";

import {
  connectionDatabases,
  connections,
  customers,
  getDb,
  mcpTokens,
  type Region,
} from "@midplane-cloud/db";
import { generateToken } from "@midplane-cloud/db/token-format";
import { encryptDsn, makeKmsContext } from "@midplane-cloud/kms";
import { hashToken, loadPepperFromKms } from "@midplane-cloud/kms/pepper";

export interface SeededConnection {
  customerId: string;
  clerkOrgId: string;
  connectionId: string;
  connectionDatabaseId: string;
  /** Default token's plaintext — the value the agent pastes into Cursor
   *  (and the value the proxy resolves via HMAC lookup). The hash is
   *  what's stored on mcp_tokens.token_hash. */
  tokenPlaintext: string;
  tokenId: string;
}

/** Seed a customer + connection + one connection_databases row + one
 *  active mcp_tokens row pointing at the supplied DSN. Returns enough
 *  identifiers for the test to drive the /mcp/<token> route and clean
 *  up afterwards. */
export async function seedConnection(opts: {
  region: Region;
  dsn: string;
  /** Defaults to 'main'. */
  databaseName?: string;
}): Promise<SeededConnection> {
  const customerId = ulid();
  const clerkOrgId = `org_e2e-${customerId}`;
  const connectionId = ulid();
  const connectionDatabaseId = ulid();
  const dbName = opts.databaseName ?? "main";

  const kms = makeKmsContext(process.env);
  const { ciphertext, kmsKeyId } = await encryptDsn(
    kms,
    opts.dsn,
    customerId,
    opts.region,
  );

  // Mint a token using the same format the cloud-side createToken uses.
  // Tests default to 'test' env so the prefix is `mp_test_...` — keeps
  // E2E rows visibly distinct from any production data that might
  // accidentally end up in a shared dev Neon branch.
  const generated = generateToken("test");
  const peppers = await loadPepperFromKms(opts.region, process.env);
  const firstKid = peppers.keys().next().value as string | undefined;
  if (!firstKid) {
    throw new Error(
      `seedConnection: no pepper available for region '${opts.region}'`,
    );
  }
  const tokenHash = hashToken(peppers.get(firstKid)!, generated.plaintext);
  const tokenId = ulid();

  const db = getDb(opts.region);
  await db.insert(customers).values({
    id: customerId,
    clerkOrgId,
    email: `e2e-${customerId}@example.test`,
    region: opts.region,
  });
  await db.insert(connections).values({
    id: connectionId,
    customerId,
    region: opts.region,
  });
  await db.insert(connectionDatabases).values({
    id: connectionDatabaseId,
    connectionId,
    name: dbName,
    encryptedDsn: ciphertext,
    kmsKeyId,
    tableAccess: { default: "read", tables: {} },
  });
  await db.insert(mcpTokens).values({
    id: tokenId,
    connectionId,
    name: "default",
    prefix: generated.prefix,
    last4: generated.last4,
    tokenHash,
    pepperKid: firstKid,
    createdByUserId: "user_e2e_seed",
  });

  return {
    customerId,
    clerkOrgId,
    connectionId,
    connectionDatabaseId,
    tokenPlaintext: generated.plaintext,
    tokenId,
  };
}

/** Derive the container name the spawner produces for a given
 *  connectionId. PR2 of mcp_url_auth_security: container names key on
 *  the lowercased connection-id slice; the plaintext token is never
 *  part of the name. */
export function containerNameFor(connectionId: string): string {
  return `midplane-${connectionId.slice(0, 16).toLowerCase()}`;
}
