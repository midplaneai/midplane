import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Imprint — Midplane",
  description:
    "Impressum / legal imprint for Deekard GmbH (Midplane) under § 5 TMG.",
};

// Static, structured content (ours, not TermsFeed) — authored as JSX rather
// than a content.ts string. Uses the shared `.legal` prose styles. The first
// <p> after the <h1> renders in the mono caption slot (`.legal h1 + p`), which
// suits the § 5 TMG subtitle line.
export default function ImprintPage() {
  return (
    <article className="legal">
      <h1>Impressum / Imprint</h1>
      <p>
        Angaben gemäß § 5 TMG / Information according to § 5 TMG (German
        Telemedia Act)
      </p>

      <h2>Deekard GmbH</h2>
      <p>
        Ella-Barowsky-Str. 17
        <br />
        10829 Berlin
        <br />
        Germany
      </p>

      <h3>Registergericht / Registry Court</h3>
      <p>
        Amtsgericht Berlin (Charlottenburg), HRB 243908
        <br />
        USt.-ID / VAT ID: DE354849548
      </p>

      <h3>Geschäftsführer / Managing Director</h3>
      <p>Dustin Lange</p>

      <h3>Vertreten durch / Represented by</h3>
      <p>Dustin Lange</p>

      <h3>Kontakt / Contact</h3>
      <p>
        <a href="mailto:info@midplane.ai">info@midplane.ai</a>
      </p>
    </article>
  );
}
