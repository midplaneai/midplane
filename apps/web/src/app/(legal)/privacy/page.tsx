import type { Metadata } from "next";

import { PRIVACY_HTML } from "./content";

export const metadata: Metadata = {
  title: "Privacy Policy — Midplane",
  description:
    "How Midplane (Deekard GmbH) collects, uses, and protects your personal data.",
};

export default function PrivacyPage() {
  // PRIVACY_HTML is our own static legal copy committed to the repo — no user
  // input flows into it, so dangerouslySetInnerHTML carries no injection risk.
  return (
    <article
      className="legal"
      dangerouslySetInnerHTML={{ __html: PRIVACY_HTML }}
    />
  );
}
