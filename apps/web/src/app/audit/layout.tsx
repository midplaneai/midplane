import { UserButton } from "@clerk/nextjs";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { redirect } from "next/navigation";

import { currentCustomer } from "@/lib/customer";
import { REGION_LABELS } from "@/lib/region";

import "./audit.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
});

export default async function AuditLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const customer = await currentCustomer();
  if (!customer) redirect("/signup/region");

  const initial = customer.email.charAt(0).toUpperCase();
  const workspaceName = customer.email.split("@")[0] ?? customer.email;

  return (
    <div className={`md-shell ${geist.variable} ${geistMono.variable}`}>
      <aside className="md-sidebar">
        <div className="md-brand">
          <span className="md-brand-mark" aria-hidden />
          midplane
        </div>
        <div className="md-nav-section">
          <div className="md-nav-label">Workspace</div>
          <Link href="/dashboard" className="md-nav-item">
            <span className="md-nav-icon" aria-hidden />
            Connections
          </Link>
          <Link href="/audit" className="md-nav-item active">
            <span className="md-nav-icon" aria-hidden />
            Audit log
          </Link>
        </div>
        <div className="md-nav-section">
          <div className="md-nav-label">Region</div>
          <div className="md-nav-item" style={{ cursor: "default" }}>
            <span className="md-nav-icon dot" aria-hidden />
            {REGION_LABELS[customer.region]}
          </div>
        </div>
        <div className="md-workspace">
          <div className="md-avatar">{initial}</div>
          <div>
            <div className="md-workspace-name">{workspaceName}</div>
            <div className="md-workspace-plan">Free plan</div>
          </div>
          <div style={{ marginLeft: "auto" }}>
            <UserButton afterSignOutUrl="/" />
          </div>
        </div>
      </aside>
      <main className="md-main">{children}</main>
    </div>
  );
}
