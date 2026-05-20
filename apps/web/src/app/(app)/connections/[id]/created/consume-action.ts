"use server";

import { cookies } from "next/headers";

import { SHOW_ONCE_COOKIE } from "@/lib/show-once-cookie";

// Server Action that deletes the show-once cookie set by the
// /connections/new server action. Server Components can read cookies
// but cannot mutate them (Next 15 throws); the mutation has to happen
// in a Server Action or Route Handler. The success page renders a
// client island (ShowOnceUrl) that fires this action on mount, so a
// reload of the success page sees the cookie absent and renders the
// "already shown" fallback.
export async function consumeShowOnceCookie(): Promise<void> {
  const c = await cookies();
  c.delete(SHOW_ONCE_COOKIE);
}
