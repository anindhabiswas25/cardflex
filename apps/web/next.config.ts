import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // The SDK ships TypeScript sources (`.ts` imports, JSON IDL).
  transpilePackages: ["@card-flex/client-sdk"],
  // The repo has its own AGENTS.md; don't generate one in apps/web.
  agentRules: false,
};

export default config;
