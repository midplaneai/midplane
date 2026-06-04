// Legal route group (/privacy, /terms). Reuses the light editorial chrome so
// these pages read as part of the marketing site, not the dark app shell.
import {
  EditorialFooter,
  EditorialTopbar,
} from "@/components/layout/editorial-chrome";

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
