// Legal route group (/privacy, /terms). Reuses the light editorial chrome so
// these pages read as part of the marketing site, not the dark app shell.
import {
  EditorialFooter,
  EditorialTopbar,
} from "@/components/layout/editorial-chrome";

// EditorialTopbar is session-aware (renders Dashboard vs Sign in), so it reads
// the session — getOrgContext() → getAuth() → getDb(bootRegion()) — which throws
// at `next build` (no MIDPLANE_REGION). These pages must render per-request, not
// be statically prerendered; force-dynamic propagates to all (legal) routes.
export const dynamic = "force-dynamic";

export default function LegalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <main className="editorial-page">
      <div className="page">
        <EditorialTopbar />
        {children}
        <EditorialFooter />
      </div>
    </main>
  );
}
