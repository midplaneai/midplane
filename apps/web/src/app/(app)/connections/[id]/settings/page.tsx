import { redirect } from "next/navigation";

// Connection settings folded into the connection workspace's Settings tab
// (region, id, rename, danger zone all live there now). This route stays
// as a permanent redirect so existing bookmarks, the dashboard [⋯] menu,
// and the db-context strip's "settings" link land on the same place.

export default async function ConnectionSettingsRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/connections/${id}?section=settings`);
}
