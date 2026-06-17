import type { MetadataRoute } from "next";

// Served at /robots.txt. The middleware matcher excludes paths containing a dot
// (".*\\..*"), so this is reachable without a session. Allow the public
// marketing + legal surfaces; keep the authenticated app, APIs, auth, and the
// agent MCP endpoint out of the index.
const BASE_URL = "https://midplane.ai";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/dashboard",
        "/audit",
        "/connections",
        "/billing",
        "/admin",
        "/api/",
        "/mcp/",
        "/signup",
        "/sign-in",
        "/sign-up",
      ],
    },
    sitemap: `${BASE_URL}/sitemap.xml`,
  };
}
