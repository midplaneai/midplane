import { redirect } from "next/navigation";

// Per-DB config folded into the connection workspace: a database's policy,
// tenant scoping, and credential now live in the workspace's Access / Source
// panes, retargeted by the ?db switcher. This route stays as a redirect so
// dashboard db rows, the [⋯] "Edit policy" item, and old bookmarks land on
// the same place instead of a separate page.

export default async function DatabaseDetailRedirect({
  params,
}: {
  params: Promise<{ id: string; name: string }>;
}) {
  const { id, name } = await params;
  redirect(
    `/connections/${id}?db=${encodeURIComponent(name)}&section=database`,
  );
}
