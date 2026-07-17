"use client";

import { useEffect, useState } from "react";

import { SUPPORT_EMAIL, supportErrorMailto } from "@/lib/support";

// Root-layout error boundary: this replaces the ENTIRE root layout when it
// errors, so it must render its own <html>/<body> and cannot use globals.css
// or the font variables — inline styles only (plus one tiny <style> block for
// hover, which inline styles can't express), hand-matched to the design
// tokens (warm-dark surface, paper text). The mailto is computed in an effect
// for the same reason as components/error-fallback.tsx: host/path/time are
// client-only and hydration doesn't reconcile a server-computed href.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The rarest, worst failure class — make sure it at least leaves a
    // console trace (server-side occurrences ride onRequestError).
    console.error(error);
  }, [error]);

  const [mailto, setMailto] = useState(`mailto:${SUPPORT_EMAIL}`);
  useEffect(() => {
    setMailto(supportErrorMailto(error.digest, "fatal"));
  }, [error.digest]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#161412",
          color: "#f3efe7",
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
        }}
      >
        <style>{`button:hover, a:hover { opacity: 0.85; }`}</style>
        <div
          style={{
            maxWidth: 480,
            width: "100%",
            border: "1px dashed #2a2622",
            padding: 40,
            textAlign: "center",
          }}
        >
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
            Something went wrong
          </h1>
          <p
            style={{
              margin: "12px 0 0",
              fontSize: 14,
              lineHeight: 1.6,
              color: "#bdb4a6",
            }}
          >
            {error.digest ? `The error was recorded (ref ${error.digest}). ` : ""}
            Try again — if it keeps happening, email us at {SUPPORT_EMAIL} and
            we&apos;ll dig in.
          </p>
          <p style={{ margin: "24px 0 0" }}>
            <button
              onClick={reset}
              style={{
                background: "#f3efe7",
                color: "#161412",
                border: "none",
                borderRadius: 6,
                padding: "8px 16px",
                fontSize: 13,
                fontWeight: 500,
                cursor: "pointer",
                marginRight: 12,
              }}
            >
              Try again
            </button>
            <a
              href={mailto}
              style={{
                color: "#f3efe7",
                fontSize: 13,
                textDecoration: "underline",
                textUnderlineOffset: 2,
              }}
            >
              Email support
            </a>
          </p>
        </div>
      </body>
    </html>
  );
}
