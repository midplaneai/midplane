import type { MetadataRoute } from "next";

// Served at /sitemap.xml. Lists only the publicly indexable surfaces — the
// landing and the legal pages. The authenticated app is intentionally absent
// (it lives behind Clerk and is disallowed in robots.txt). No lastModified:
// these are static, and Date is unavailable at module scope in some runtimes.
const BASE_URL = "https://midplane.ai";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${BASE_URL}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${BASE_URL}/privacy`, changeFrequency: "yearly", priority: 0.4 },
    { url: `${BASE_URL}/terms`, changeFrequency: "yearly", priority: 0.4 },
    { url: `${BASE_URL}/imprint`, changeFrequency: "yearly", priority: 0.3 },
  ];
}
