// The per-DB context strip (← project │ db tabs │ settings) is gone: the
// project workspace's left rail is the single, persistent nav now, and the
// child page only redirects into it. Kept as a passthrough so the redirect
// runs without re-introducing page chrome.

export default function DatabaseRedirectLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
