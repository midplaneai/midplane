import type { MetadataRoute } from "next";

// This origin (app.midplane.ai) is the authenticated product. The public
// marketing + legal surfaces moved to midplane.ai, which serves its own
// robots + sitemap. Keep the whole app out of search indexes.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      disallow: "/",
    },
  };
}
