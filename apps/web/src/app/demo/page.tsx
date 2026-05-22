// `/demo` — interactive landing-page demo. No DB, no engine spawn,
// no auth. The visitor edits an in-memory table_access allowlist and
// sends natural-language requests; a server-side Azure OpenAI call
// translates them to SQL, and a client-side evaluator that mirrors
// the engine's decision shape decides whether they would have been
// allowed. The audit log fills in beneath.

import Link from "next/link";

import { DemoChat } from "./demo-chat";

export const metadata = {
  title: "Try midplane · live demo",
  description:
    "Send a query, edit the policy, watch the audit log. No signup, no database connection.",
};

export default function DemoPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-[1280px] px-6 py-10">
        <header className="mb-8 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <Link
              href="/"
              className="inline-flex items-center gap-2 font-medium text-foreground"
            >
              <span className="inline-block h-[18px] w-[18px] rounded-[4px] bg-foreground" />
              <span>midplane</span>
            </Link>
            <span className="font-mono text-[10px] uppercase tracking-[0.04em] text-subtle">
              demo · seeded fixtures · no real database
            </span>
          </div>
          <div className="flex max-w-[760px] flex-col gap-3">
            <h1 className="text-[30px] font-semibold leading-tight tracking-[-0.025em] text-foreground">
              Ask the database. Watch the policy. Read the audit.
            </h1>
            <p className="text-[15px] text-muted-foreground">
              An LLM translates your request into SQL. Midplane decides
              whether to forward it to the (seeded) database. Every
              attempt — allowed or denied — lands in the audit log
              below. Edit the allowlist on the right and re-send any
              prompt to see the decision change.
            </p>
          </div>
        </header>
        <DemoChat />
      </div>
    </main>
  );
}
