import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Same guard as apps/web — see the comment there. NEXT_PUBLIC_* values are compiled in,
// so a malformed one ships and is only visible from a browser.
for (const key of ["NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_API_URL"]) {
  const value = process.env[key];
  if (!value) continue;
  try {
    new URL(value);
  } catch {
    throw new Error(
      `${key} is not a valid URL: "${value}"\n` +
        `Check .env — the most common cause is pasting the whole "${key}=..." line into the value.`,
    );
  }
}

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