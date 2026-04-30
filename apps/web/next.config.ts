import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // Drizzle + postgres-js pull pg-native via optional deps; mark them external
  // so Next's bundler doesn't try to resolve them in the edge runtime.
  serverExternalPackages: ["postgres", "drizzle-orm"],
};

export default config;
