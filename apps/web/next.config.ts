import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config: NextConfig = {
  reactStrictMode: true,
  // Standalone bundle for the Fly Docker deploy (fly-web.toml).
  output: "standalone",
  // Trace deps from the monorepo root so workspace packages
  // (@midplane-cloud/db, /kms, /router) ship inside the standalone output.
  outputFileTracingRoot: path.join(__dirname, "../../"),
  // Drizzle + postgres-js pull pg-native via optional deps; mark them external
  // so Next's bundler doesn't try to resolve them in the edge runtime.
  serverExternalPackages: ["postgres", "drizzle-orm"],
};

export default config;
