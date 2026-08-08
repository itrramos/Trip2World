import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** @type {import("next").NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // See apps/web/next.config.mjs for why this uses fileURLToPath and why standalone is
  // escapable on Windows.
  ...(process.env.NEXT_DISABLE_STANDALONE === "1"
    ? {}
    : { output: "standalone", outputFileTracingRoot: repoRoot }),

  transpilePackages: ["@trip2world/shared", "@trip2world/types", "@trip2world/ui"],

  poweredByHeader: false,

  eslint: { ignoreDuringBuilds: true },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          // The moderation panel must never appear in a search index or a link preview.
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
        ],
      },
    ];
  },
};

export default nextConfig;