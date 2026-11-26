import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // Production build is a self-contained server (.next/standalone), so a
  // deploy needs only that folder plus static files, no node_modules.
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  // The SDK ships TypeScript sources (`.ts` imports, JSON IDL).
  transpilePackages: ["@card-flex/client-sdk"],
  // The repo has its own AGENTS.md; don't generate one in apps/web.
  agentRules: false,
};

export default config;
