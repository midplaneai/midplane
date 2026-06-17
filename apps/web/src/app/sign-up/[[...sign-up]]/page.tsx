import { SignUpForm } from "@/components/auth/sign-up-form";
import { BrandLockup } from "@/components/layout/brand-mark";

// Only allow same-origin relative redirects (no open redirect via ?redirect).
function safeRedirect(value: string | undefined, fallback: string): string {
  return typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//")
    ? value
    : fallback;
}

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string }>;
}) {
  const { redirect } = await searchParams;
  return (
    <main className="flex min-h-screen flex-col">
      <header className="border-b border-border px-10 py-5">
        <BrandLockup />
      </header>
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <SignUpForm redirectTo={safeRedirect(redirect, "/signup/region")} />
      </div>
    </main>
  );
}
