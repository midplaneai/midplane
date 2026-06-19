// Shared DB-seeding helpers for live E2E suites.
//
// PR2 of mcp_url_auth_security: projects no longer carry a plaintext
// mcp_token column; the agent-facing token lives in the new mcp_tokens
// table, hashed at rest via HMAC-SHA256(pepper). E2E suites that bypass
// the UI and seed the cloud DB directly need to mint a real token row
// (and capture its plaintext) so the proxy / indexer / spawner pipeline
// resolves it the same way a Server-Action-created project would.
//
// Trust posture: pepper is read from the env via loadPepperFromKms.
// Tests run against MIDPLANE_KMS_MODE=env with
// MIDPLANE_TOKEN_PEPPER_<REGION>_V1 set by .env.local — same shape as
// dev. Anyone running E2E against a real KMS-mode deploy needs the IAM
// scoping set up first (out of scope for this helper).

import { ulid } from "ulid";

import {
  projectDatabases,
  projects,
  customers,
  getDb,
  mcpTokens,
  type Region,
} from "@midplane-cloud/db";
import { generateToken } from "@midplane-cloud/db/token-format";
import { encryptDsn, makeKmsContext } from "@midplane-cloud/kms";
import { hashToken, loadPepperFromKms } from "@midplane-cloud/kms/pepper";

export interface SeededProject {
  customerId: string;
  orgId: string;
  projectId: string;
  projectDatabaseId: string;
  /** Default token's plaintext — the value the agent pastes into Cursor
   *  (and the value the proxy resolves via HMAC lookup). The hash is
   *  what's stored on mcp_tokens.token_hash. */
  tokenPlaintext: string;
  tokenId: string;
}

/** Seed a customer + project + one project_databases row + one
 *  active mcp_tokens row pointing at the supplied DSN. Returns enough
 *  identifiers for the test to drive the /mcp/<token> route and clean
 *  up afterwards. */
export async function seedProject(opts: {
  region: Region;
  dsn: string;
  /** Defaults to 'main'. */
  databaseName?: string;
}): Promise<SeededProject> {
  const customerId = ulid();
  const orgId = `org_e2e-${customerId}`;
  const projectId = ulid();
  const projectDatabaseId = ulid();
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
      `seedProject: no pepper available for region '${opts.region}'`,
    );
  }
  const tokenHash = hashToken(peppers.get(firstKid)!, generated.plaintext);
  const tokenId = ulid();

  const db = getDb(opts.region);
  await db.insert(customers).values({
    id: customerId,
    orgId,
    email: `e2e-${customerId}@example.test`,
    region: opts.region,
  });
  await db.insert(projects).values({
    id: projectId,
    customerId,
    region: opts.region,
  });
  await db.insert(projectDatabases).values({
    id: projectDatabaseId,
    projectId,
    name: dbName,
    encryptedDsn: ciphertext,
    kmsKeyId,
    tableAccess: { default: "read", tables: {} },
  });
  await db.insert(mcpTokens).values({
    id: tokenId,
    projectId,
    name: "default",
    prefix: generated.prefix,
    last4: generated.last4,
    tokenHash,
    pepperKid: firstKid,
    createdByUserId: "user_e2e_seed",
  });

  return {
    customerId,
    orgId,
    projectId,
    projectDatabaseId,
    tokenPlaintext: generated.plaintext,
    tokenId,
  };
}

/** Derive the container name the spawner produces for a given
 *  projectId. PR2 of mcp_url_auth_security: container names key on
 *  the lowercased project-id slice; the plaintext token is never
 *  part of the name. */
export function containerNameFor(projectId: string): string {
  return `midplane-${projectId.slice(0, 16).toLowerCase()}`;
}
