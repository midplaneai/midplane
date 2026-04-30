import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
});

export const metadata: Metadata = {
  title: "Midplane",
  description:
    "The safety layer between AI coding agents and your Postgres.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider
      appearance={{
        variables: {
          colorBackground: "#111111",
          colorInputBackground: "#161616",
          colorInputText: "#f5f5f5",
          colorText: "#f5f5f5",
          colorTextSecondary: "#b4b4b4",
          colorPrimary: "#f5f5f5",
          colorNeutral: "#f5f5f5",
          colorDanger: "#c87070",
          colorSuccess: "#5a9c6e",
          colorWarning: "#d4a04c",
          borderRadius: "0.5rem",
          fontFamily: "var(--font-geist), -apple-system, sans-serif",
        },
      }}
    >
      <html lang="en" className={`dark ${geist.variable} ${geistMono.variable}`}>
        <body className="min-h-screen bg-background font-sans text-foreground antialiased">
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
