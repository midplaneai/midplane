import { redirect } from "next/navigation";

// `/projects` has no page of its own — the nav "Projects" link points at
// `/dashboard`, which IS the project list. A user who strips the id off
// `/projects/<id>` in the URL bar used to hit a raw Next 404; send them to the
// list instead, which is what a bare `/projects` plainly means.
export default function ProjectsIndex(): never {
  redirect("/dashboard");
}
