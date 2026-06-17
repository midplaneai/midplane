"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

import { removeSsoProvider } from "./actions";

// SAML SSO configuration for the active organization. Thin UI over the
// @better-auth/sso plugin: register() mints the org's provider (the plugin
// enforces owner/admin since organizationId is supplied), and the remove server
// action deletes it. The Service-Provider URLs below are what the admin pastes
// into their identity provider (Okta, Azure AD, …).

export interface SsoProviderView {
  providerId: string;
  domain: string;
  issuer: string;
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
        <div className="space-y-3 border-t border-border pt-6">
          <div className="text-sm">
            <p className="text-foreground">
              SAML is active for{" "}
              <strong className="font-medium">{current.domain}</strong>.
            </p>
            <p className="mt-1 break-all text-muted-foreground">
              Issuer: <span className="font-mono text-xs">{current.issuer}</span>
            </p>
          </div>
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
