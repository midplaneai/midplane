// Shared chrome for the light editorial surfaces (landing + legal pages).
// Extracted from the landing so the topbar/footer — and the footer's Legal
// links — live in one place instead of being inlined per page.
//
// Nav + footer section anchors are absolute (`/#policy`) so they resolve from
// any route, not just the landing itself.
import { auth } from "@clerk/nextjs/server";
import Link from "next/link";

export async function EditorialTopbar() {
  // Signed-in visitors get a one-click Dashboard link in place of the
  // Sign in / Start free pair — same behavior the landing had inline.
  const { userId } = await auth();
  const isSignedIn = !!userId;

  return (
    <header className="topbar">
      <Link href="/" aria-label="midplane" className="brand mp-wordmark">
        mid<span className="mp-colon">:</span>plane
      </Link>
      <nav className="nav">
        <Link href="/#policy">Policy</Link>
        <Link href="/#audit">Audit</Link>
        <Link href="/#pricing">Pricing</Link>
        <a href="https://midplane.ai/docs">Docs</a>
      </nav>
      <div className="topright">
        <a
          href="https://github.com/midplaneai/midplane"
          target="_blank"
          rel="noopener noreferrer"
        >
          GitHub
        </a>
        {isSignedIn ? (
          <a className="ebtn fill" href="/dashboard">
            Dashboard →
          </a>
        ) : (
          <>
            <Link href="/sign-in">Sign in</Link>
            <Link className="ebtn fill" href="/sign-up">
              Start free
            </Link>
          </>
        )}
      </div>
    </header>
  );
}

export function EditorialFooter() {
  return (
    <footer className="efoot">
      <div>
        <span className="brand mp-wordmark mp-on-dark" aria-label="midplane">
          mid<span className="mp-colon">:</span>plane
        </span>
      </div>
      <div>
        <h5>Product</h5>
        <Link href="/#audit">Audit</Link>
        <Link href="/#policy">Policy</Link>
        <Link href="/#pricing">Pricing</Link>
        <a href="https://midplane.ai/docs">Docs</a>
      </div>
      <div>
        <h5>Open</h5>
        <a
          href="https://github.com/midplaneai/midplane"
          target="_blank"
          rel="noopener noreferrer"
        >
          github.com/midplaneai/midplane
        </a>
      </div>
      <div>
        <h5>Legal</h5>
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms</Link>
        <Link href="/imprint">Imprint</Link>
      </div>
    </footer>
  );
}
