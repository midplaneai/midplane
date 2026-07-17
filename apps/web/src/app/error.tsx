"use client";

import { ErrorFallback } from "@/components/error-fallback";

// Root error boundary — covers public pages and the shell itself. Errors in
// authenticated pages are caught by app/(app)/error.tsx first, which keeps
// the sidebar/nav mounted. Shared body: components/error-fallback.tsx.
export default function ErrorPage(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorFallback {...props} />;
}
