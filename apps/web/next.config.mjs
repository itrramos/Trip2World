import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Repository root, resolved as a real filesystem path.
 *
 * `new URL('../../', import.meta.url).pathname` looks equivalent but is not: it yields a
 * URL path, which on Windows is `/C:/Users/...` — a leading slash before the drive
 * letter. Next.js cannot resolve that, and rather than failing it silently skips the
 * standalone build, so `.next/standalone` never appears and the Docker COPY fails much
 * later with a confusing error. `fileURLToPath` produces the correct path on every
 * platform.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  /**
   * Standalone output: Next traces the real module graph and emits a self-contained
   * server, so the runtime image needs no package manager and no node_modules copy.
   *
   * `outputFileTracingRoot` must point at the monorepo root — otherwise tracing stops at
   * apps/web and the workspace packages (@trip2world/shared, /types) are left out of the
   * bundle. That failure only appears at runtime, as a module-not-found in the container.
   */
  /**
   * Standalone is what the production image ships, so it is the default.
   *
   * It can be disabled with NEXT_DISABLE_STANDALONE=1 for local builds on Windows, where
   * creating symlinks requires elevated privileges and the trace-copy step fails with
   * EPERM *after* a successful compile. That is a platform limitation, not a code fault —
   * the Docker build runs on Linux and is unaffected — but without an escape hatch a
   * Windows contributor cannot verify their own build.
   */
  ...(process.env.NEXT_DISABLE_STANDALONE === '1'
    ? {}
    : { output: 'standalone', outputFileTracingRoot: repoRoot }),

  // Workspace packages ship TypeScript source, so Next must compile them itself.
  transpilePackages: ['@trip2world/shared', '@trip2world/types', '@trip2world/validation'],

  poweredByHeader: false,

  eslint: {
    // Linting runs as its own CI step; a lint error should not fail a deploy build.
    ignoreDuringBuilds: true,
  },

  images: {
    // Avatars are the only remote images, and they are restricted to https public hosts
    // by the validation schema before they are ever stored.
    remotePatterns: [{ protocol: 'https', hostname: '**' }],
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // getUserMedia is required for the product; everything else is denied.
          {
            key: 'Permissions-Policy',
            value: 'camera=(self), microphone=(self), geolocation=(), payment=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
