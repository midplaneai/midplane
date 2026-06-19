import { redirect } from "next/navigation";

// The marketing landing now lives at midplane.ai (its own repo). This app's
// root just sends visitors into the product; /dashboard enforces auth + region
// (and bounces signed-out users to /sign-in via the middleware + (app) layout).
export default function Home() {
  redirect("/dashboard");
}
