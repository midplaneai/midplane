import { redirect } from "next/navigation";

// `/projects` has no page of its own — the nav "Projects" link points at
// `/dashboard` (the project list), and a single-project account is bounced
// straight into `/projects/<id>` from there, so the URL bar reads
// `/projects/<id>`. Stripping the id to a bare `/projects` used to hit a raw
// Next 404. Redirect to `/dashboard` instead, which owns the count-aware
// behavior: one project → straight into it, many → the list.
export default function ProjectsIndex(): never {
  redirect("/dashboard");
}
