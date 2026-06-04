import type { Metadata } from "next";

import { TERMS_HTML } from "./content";

export const metadata: Metadata = {
  title: "Terms and Conditions — Midplane",
  description:
    "The terms governing your use of Midplane, operated by Deekard GmbH.",
};

export default function TermsPage() {
  // TERMS_HTML is our own static legal copy committed to the repo — no user
  // input flows into it, so dangerouslySetInnerHTML carries no injection risk.
  return (
    <article className="legal" dangerouslySetInnerHTML={{ __html: TERMS_HTML }} />
  );
}
