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
// assertion replay protection and the domain-verification token reuse the core
// `verification` table, so the plugin needs no extra storage here.

/** DNS verification token prefix. Short on purpose: the verification host is
 *  `_<prefix>-<providerId>.<domain>` and the `_<prefix>-<providerId>` label must
 *  stay under the 63-char DNS limit (providerId is `saml-<orgId>`). Mirrored in
 *  the settings UI (settings/sso/sso-settings.tsx) to render the TXT record. */
export const SSO_DOMAIN_TOKEN_PREFIX = "mp";

/** The Enterprise SSO plugin(s), for the boot-time registry. A function (not a
 *  top-level constant) so importing this module is side-effect-free and the
 *  plugin is constructed only when the ee bootstrap actually registers it. */
export function buildSsoPlugins(): BetterAuthPlugin[] {
  return [
    sso({
      // Federate into the acting organization: when a (verified) provider is
      // registered with an organizationId, add the SSO user to that org on first
      // sign-in. member by default — the configuring admin keeps owner; SSO
      // joiners are members. One org == one Midplane customer, so this is the
      // tenant join.
      organizationProvisioning: {
        disabled: false,
        defaultRole: "member",
      },
      // REQUIRE DNS domain verification. Without this, an org admin could
      // register a domain they don't control (gmail.com, a competitor's domain)
      // and — because the plugin matches providers by email domain and
      // domain-provisions users — capture SSO sign-in/provisioning for it. With
      // verification on, the plugin filters provider matching, sign-in, and
      // org-provisioning on domainVerified=true (and only auto-links accounts
      // for verified domains), so an unverified provider is completely inert
      // until the org proves DNS control. The token is stored in the core
      // `verification` table; `domainVerified` lives on ssoProvider (0027).
      domainVerification: {
        enabled: true,
        tokenPrefix: SSO_DOMAIN_TOKEN_PREFIX,
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
