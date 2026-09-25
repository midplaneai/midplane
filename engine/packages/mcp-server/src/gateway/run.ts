// `midplane gateway` — the engine as a customer-run gateway.
//
// Pipeline: config (refuses a second policy source, a non-loopback bind, a
// missing salt) → state dir → enroll on first boot → build an EMPTY engine →
// re-apply the cached bundle, if any → serve /mcp on loopback → poll Midplane
// Cloud for newer bundles and heartbeat.
//
// Policy arrives only as signed bundles; database credentials only as the
// MIDPLANE_DSN_* variables a bundle names; the mask salt only from this
// process's environment. Nothing here listens on anything but loopback, and
// every connection to Midplane Cloud is outbound.

import { warmup, type AuditWriter } from "@midplane/engine";
import { version as PACKAGE_VERSION } from "../../package.json" with { type: "json" };
import { HttpApprovalGate } from "../approval-gate.ts";
import { DenyWebhookAuditWriter, loadDenyWebhookConfig } from "../deny-webhook.ts";
import { buildEngine } from "../engine-factory.ts";
import { logger } from "../logger.ts";
import { installShape, runtimeLabel } from "../runtime.ts";
import { buildServer } from "../server.ts";
import { initTelemetry } from "../telemetry/index.ts";
import { startHttp } from "../transport/http.ts";
import { ENGINE_FEATURES } from "../config.ts";
import { DEFAULT_POLL_SECONDS, isLoopbackAddress, loadGatewayConfig, MIN_POLL_SECONDS } from "./config.ts";
import { ensureIdentity } from "./enroll.ts";
import { APPROVALS_PATH, LinkClient } from "./link-client.ts";
import { BUNDLE_FIELDS_V1 } from "./protocol.ts";
import { GatewayRuntime, LINK_CAPABILITIES } from "./runtime.ts";
import { GatewayStateDir } from "./state.ts";

export async function runGateway(): Promise<void> {
  let cfg;
  let denyWebhook;
  try {
    cfg = loadGatewayConfig(process.env);
    denyWebhook = loadDenyWebhookConfig(process.env);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }

  await warmup();

  const state = GatewayStateDir.open(cfg.stateDir);
  const client = new LinkClient(cfg.cloudUrl, `midplane-gateway/${PACKAGE_VERSION}`);

  let enrolled;
  try {
    enrolled = await ensureIdentity(
      state,
      client,
      {
        cloudUrl: cfg.cloudUrl,
        enrollToken: cfg.enrollToken,
        name: cfg.name,
        engineVersion: PACKAGE_VERSION,
        capabilities: {
          link: [...LINK_CAPABILITIES],
          bundle_fields: [...BUNDLE_FIELDS_V1],
          policy_features: [...ENGINE_FEATURES].sort(),
        },
      },
      logger,
    );
  } catch (err) {
    process.stderr.write(`midplane gateway: ${(err as Error).message}\n`);
    process.exit(1);
  }
  const { identity } = enrolled;

  const telemetry = initTelemetry({ dbPath: cfg.engine.dbPath, version: PACKAGE_VERSION, transport: "http" });
  const wrapAudit = (w: AuditWriter): AuditWriter => {
    let result = telemetry.wrap(w);
    if (denyWebhook) result = new DenyWebhookAuditWriter(result, denyWebhook);
    return result;
  };

  // The runtime is built after the gate but the gate signs with the runtime's
  // signer; a late-bound reference keeps construction order simple.
  let runtime: GatewayRuntime | undefined;
  // Always wired, whether or not a bundle holds writes yet: turning approvals
  // on is then a pure bundle change. Each call carries a request token signed
  // for exactly that path and body — there is no static gate secret.
  const approvalGate = new HttpApprovalGate({
    url: `${cfg.cloudUrl}${APPROVALS_PATH}`,
    authorize: (method, path, body) => client.authorization(runtime!.requestSigner, method, path, body),
  });

  const handle = buildEngine(cfg.engine, { startEmpty: true, approvalGate, wrapAudit });
  runtime = new GatewayRuntime({
    identity,
    privateKey: enrolled.privateKey,
    state,
    client,
    handle,
    env: process.env,
    pollSeconds: Math.max(cfg.pollSeconds ?? identity.poll_seconds ?? DEFAULT_POLL_SECONDS, MIN_POLL_SECONDS),
    engineVersion: PACKAGE_VERSION,
    runtimeLabel: runtimeLabel(),
    installShape: installShape(),
    tenantId: cfg.engine.tenantId,
    log: logger,
  });
  await runtime.bootFromCache();

  const guard = runtime.servingGuard();
  const http = await startHttp(
    (sessionContext) => buildServer({ handle, telemetry, approvalGate, sessionContext, serving: guard }),
    {
      port: cfg.engine.port,
      host: cfg.engine.host,
      health: () => runtime!.health(),
      // No indexer or admin routes: a gateway's policy comes only from bundles,
      // and its audit leaves only by the (future) authenticated push.
      identityHeaders: false,
    },
  );
  // Config already refused a non-loopback MIDPLANE_HOST; check what the socket
  // actually bound too, since that — not the setting — is the property.
  if (!isLoopbackAddress(http.address)) {
    process.stderr.write(`midplane gateway: bound ${http.address}, which is not loopback; refusing to serve\n`);
    await http.close();
    process.exit(1);
  }

  runtime.start();
  telemetry.markReady();
  logger.info(
    {
      gateway_id: identity.gateway_id,
      project_id: identity.project_id,
      state: runtime.state,
      url: http.url,
    },
    "midplane gateway started",
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    try {
      runtime!.stop();
      await http.close();
      await telemetry.shutdown();
      await handle.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
