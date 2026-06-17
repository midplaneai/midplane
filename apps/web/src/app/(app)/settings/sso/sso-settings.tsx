"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

import { removeSsoProvider } from "./actions";

// SAML SSO configuration for the active organization. Thin UI over the
// @better-auth/sso plugin: register() mints the org's provider (the plugin
// enforces owner/admin since organizationId is supplied; the server also gates
// register on the sso entitlement), and the remove server action deletes it.
// The Service-Provider URLs below are what the admin pastes into their identity
// provider (Okta, Azure AD, …). A provider stays INACTIVE until the org proves
// DNS control of the domain (the verify flow below) — that's what stops an org
// claiming a domain it doesn't own.

// Must match SSO_DOMAIN_TOKEN_PREFIX in ee/sso/index.ts — core can't import ee/,
// so the DNS verification host format is duplicated here. The plugin verifies a
// TXT record at `_<prefix>-<providerId>.<domain>` containing
// `_<prefix>-<providerId>=<token>`.
const SSO_DOMAIN_TOKEN_PREFIX = "mp";

export interface SsoProviderView {
  providerId: string;
  domain: string;
  issuer: string;
  domainVerified: boolean | null;
}

/** A read-only field the admin copies into their IdP. */
function CopyableUrl({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <span className="text-xs lowercase text-muted-foreground">{label}</span>
      <code className="block break-all rounded-none border border-border bg-secondary px-3 py-2 font-mono text-xs text-foreground">
        {value}
      </code>
    </div>
  );
}

export function SsoSettings({
  orgId,
  providerId,
  acsUrl,
  metadataUrl,
  audience,
  current,
}: {
  orgId: string;
  providerId: string;
  acsUrl: string;
  metadataUrl: string;
  audience: string;
  current: SsoProviderView | null;
}) {
  const router = useRouter();
  const [domain, setDomain] = useState("");
  const [issuer, setIssuer] = useState("");
  const [entryPoint, setEntryPoint] = useState("");
  const [cert, setCert] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [removing, startRemove] = useTransition();
  const [token, setToken] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  const needsVerify = Boolean(current && !current.domainVerified);
  const identifier = `_${SSO_DOMAIN_TOKEN_PREFIX}-${providerId}`;
  const txt =
    needsVerify && current && token
      ? { host: `${identifier}.${current.domain}`, value: `${identifier}=${token}` }
      : null;

  // Fetch (or regenerate) the DNS verification token for an unverified provider
  // so we can render the TXT record the admin must publish. The domain-
  // verification endpoints aren't on the ssoClient's typed surface, so we hit
  // them through the client's generic $fetch (resolves under /api/auth).
  // request-domain-verification returns the active token or mints a fresh one.
  useEffect(() => {
    if (!needsVerify) return;
    let active = true;
    authClient
      .$fetch<{ domainVerificationToken: string }>(
        "/sso/request-domain-verification",
        { method: "POST", body: { providerId } },
      )
      .then(({ data }) => {
        if (active && data?.domainVerificationToken) {
          setToken(data.domainVerificationToken);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [needsVerify, providerId]);

  async function onVerify() {
    setError(null);
    setVerifying(true);
    const { error: vErr } = await authClient.$fetch("/sso/verify-domain", {
      method: "POST",
      body: { providerId },
    });
    setVerifying(false);
    if (vErr) {
      setError(
        vErr.message ??
          "Couldn’t verify the domain yet — DNS records can take time to propagate. Try again shortly.",
      );
      return;
    }
    router.refresh();
  }

  async function onAdd(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const { error: regError } = await authClient.sso.register({
      providerId,
      issuer: issuer.trim(),
      domain: domain.trim(),
      organizationId: orgId,
      samlConfig: {
        entryPoint: entryPoint.trim(),
        cert: cert.trim(),
        callbackUrl: acsUrl,
        audience,
        wantAssertionsSigned: true,
        signatureAlgorithm: "sha256",
        digestAlgorithm: "sha256",
        identifierFormat:
          "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
        // Our Service Provider identity. entityID = audience (this app's base
        // URL); the plugin serves the SP metadata XML at the metadata URL shown
        // above, so we don't hand-author the descriptor.
        spMetadata: { entityID: audience },
      },
    });
    setPending(false);
    if (regError) {
      setError(
        regError.message ??
          "Could not save the SAML connection. Check the certificate and URLs.",
      );
      return;
    }
    router.refresh();
  }

  function onRemove() {
    setError(null);
    startRemove(async () => {
      const res = await removeSsoProvider(providerId);
      if (res?.error) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Configure these <strong className="font-medium text-foreground">Service
        Provider</strong> values in your identity provider, then add your IdP&apos;s
        sign-on URL and certificate below.
      </p>

      <div className="space-y-3">
        <CopyableUrl label="ACS / reply URL" value={acsUrl} />
        <CopyableUrl label="SP metadata" value={metadataUrl} />
        <CopyableUrl label="audience / entity ID" value={audience} />
      </div>

      {current ? (
        <div className="space-y-4 border-t border-border pt-6">
          <div className="text-sm">
            <p className="text-foreground">
              SAML is configured for{" "}
              <strong className="font-medium">{current.domain}</strong>
              {current.domainVerified ? (
                <span className="text-[hsl(var(--allow))]"> — domain verified.</span>
              ) : (
                <span className="text-[hsl(var(--warn))]">
                  {" "}
                  — pending domain verification.
                </span>
              )}
            </p>
            <p className="mt-1 break-all text-muted-foreground">
              Issuer: <span className="font-mono text-xs">{current.issuer}</span>
            </p>
          </div>

          {needsVerify && (
            <div className="space-y-3 border border-border bg-secondary px-4 py-4">
              <p className="text-sm text-foreground">
                <strong className="font-medium">Verify domain ownership.</strong>{" "}
                SSO stays inactive until you prove control of{" "}
                <span className="font-mono text-xs">{current.domain}</span>. Add
                this DNS TXT record at your DNS provider, then verify.
              </p>
              {txt ? (
                <div className="space-y-3">
                  <CopyableUrl label="TXT host" value={txt.host} />
                  <CopyableUrl label="TXT value" value={txt.value} />
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Loading DNS record…
                </p>
              )}
              <Button
                type="button"
                size="sm"
                onClick={onVerify}
                disabled={verifying || !txt}
              >
                {verifying ? "Verifying…" : "Verify domain"}
              </Button>
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-[hsl(var(--deny))]">
              {error}
            </p>
          )}
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={onRemove}
            disabled={removing}
          >
            {removing ? "Removing…" : "Remove SAML connection"}
          </Button>
        </div>
      ) : (
        <form onSubmit={onAdd} className="space-y-4 border-t border-border pt-6">
          <div className="space-y-2">
            <Label htmlFor="sso-domain">Email domain</Label>
            <Input
              id="sso-domain"
              name="sso-domain"
              required
              placeholder="company.com"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sso-issuer">IdP issuer / entity ID</Label>
            <Input
              id="sso-issuer"
              name="sso-issuer"
              required
              placeholder="https://idp.company.com/…"
              value={issuer}
              onChange={(e) => setIssuer(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sso-entrypoint">IdP sign-on URL</Label>
            <Input
              id="sso-entrypoint"
              name="sso-entrypoint"
              required
              placeholder="https://idp.company.com/sso/saml"
              value={entryPoint}
              onChange={(e) => setEntryPoint(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sso-cert">IdP x.509 certificate</Label>
            <textarea
              id="sso-cert"
              name="sso-cert"
              required
              rows={6}
              placeholder="-----BEGIN CERTIFICATE-----&#10;…&#10;-----END CERTIFICATE-----"
              value={cert}
              onChange={(e) => setCert(e.target.value)}
              className="w-full rounded-none border border-border bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-[hsl(var(--deny))]">
              {error}
            </p>
          )}

          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Saving…" : "Save SAML connection"}
          </Button>
        </form>
      )}
    </div>
  );
}
