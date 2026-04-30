import { SignUp } from "@clerk/nextjs";

import { BrandLockup } from "@/components/layout/brand-mark";

export default function SignUpPage() {
  return (
    <main className="flex min-h-screen flex-col">
      <header className="border-b border-border px-10 py-5">
        <BrandLockup />
      </header>
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <SignUp />
      </div>
    </main>
  );
}
