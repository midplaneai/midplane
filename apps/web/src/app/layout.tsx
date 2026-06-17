import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
});

// In plain text the colon is a typesetting choice for the brand mark, not
// a renaming of the product. Anywhere a parser or screen reader sees this
// (title, og:*, twitter:*), we write "Midplane" — no colon.
export const metadata: Metadata = {
  title: "Midplane — Safe Postgres for your team's AI agents.",
  description:
    "Midplane is a thin access layer in front of your existing Postgres. Read-only by default. Writes opt-in per table. Every query logged.",
  metadataBase: new URL("https://midplane.ai"),
  icons: {
    icon: [
      { url: "/brand/favicon.svg", type: "image/svg+xml" },
      { url: "/brand/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/brand/favicon-16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [{ url: "/brand/apple-touch-icon.png", sizes: "180x180" }],
  },
  openGraph: {
    title: "Midplane — Safe Postgres for your team's AI agents.",
    description:
      "A thin access layer that sits in front of your existing Postgres. Read-only by default. Writes opt-in per table. Every query logged.",
    url: "https://midplane.ai",
    siteName: "Midplane",
    images: [{ url: "/brand/og-card.svg", width: 1200, height: 630 }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Midplane — Safe Postgres for your team's AI agents.",
    description:
      "A thin access layer that sits in front of your existing Postgres. Read-only by default. Writes opt-in per table. Every query logged.",
    images: ["/brand/og-card.svg"],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`dark ${geist.variable} ${geistMono.variable}`}>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
