"use client";

import { ErrorFallback } from "@/components/error-fallback";

// Error boundary for authenticated pages. Nested inside the (app) layout so
// a page crash keeps the AppShell (sidebar, mobile nav, help links) mounted —
// the root boundary would unmount all navigation exactly when the user needs
// a way onward. Shared body: components/error-fallback.tsx.
export default function AppErrorPage(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorFallback {...props} />;
}
