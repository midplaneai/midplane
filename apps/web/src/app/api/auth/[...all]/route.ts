import { getAuth } from "@/lib/auth";

// Better Auth catch-all handler (/api/auth/*) — sign-up / sign-in / session /
// organization endpoints. We call getAuth() INSIDE each verb — not via
// toNextJsHandler(getAuth()) at module scope — so the regional DB binding
// (bootRegion → getDb) resolves at request time, not at build/eval.

export async function GET(req: Request): Promise<Response> {
  return getAuth().handler(req);
}

export async function POST(req: Request): Promise<Response> {
  return getAuth().handler(req);
}
