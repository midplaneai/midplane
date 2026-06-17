import { sso } from "@better-auth/sso";
import type { BetterAuthPlugin } from "better-auth";

// SSO/SAML — the first Enterprise Edition feature (P5). Commercial, NOT MIT.
//
// Builds the Better Auth `sso` plugin (@better-auth/sso): SAML 2.0 + OIDC
// federation so an organization signs its members in through its own identity
// provider (Okta, Azure AD, …). This module lives in ee/ and is spliced into the
// core auth instance ONLY through the boot-time registry (lib/ee-plugins.ts),
// wired by src/ee/register.ts — core never imports it.
//
// One provider per org: the org-settings surface registers a provider with
// `organizationId` set, so organizationProvisioning auto-adds a federated user
// to that organization (as a member) on first SSO sign-in. The org owner who
// configured SSO keeps their owner role; new SSO arrivals come in as members.
//
// The storage table is `ssoProvider` (migration 0027 / auth-schema.ts). SAML
// assertion replay protection reuses the core `verification` table, so the
// plugin needs no extra storage here.

/** The Enterprise SSO plugin(s), for the boot-time registry. A function (not a
 *  top-level constant) so importing this module is side-effect-free and the
 *  plugin is constructed only when the ee bootstrap actually registers it. */
export function buildSsoPlugins(): BetterAuthPlugin[] {
  return [
    sso({
      // Federate into the acting organization: when a provider is registered
      // with an organizationId, add the SSO user to that org on first sign-in.
      // member by default — the configuring admin keeps owner; SSO joiners are
      // members. One org == one Midplane customer, so this is the tenant join.
      organizationProvisioning: {
        disabled: false,
        defaultRole: "member",
      },
      saml: {
        // Reject SAML assertions whose signature/digest uses a deprecated
        // algorithm (SHA-1, RSA 1.5, 3DES) — this is an enterprise security
        // feature; fail closed rather than warn. Replay protection + timestamp
        // checks are on by the plugin's defaults.
        algorithms: { onDeprecated: "reject" },
      },
    }) as BetterAuthPlugin,
  ];
}
