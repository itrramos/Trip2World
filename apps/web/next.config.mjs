import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import createNextIntlPlugin from 'next-intl/plugin';

// Points the plugin at the request config; without this it looks for a default path.
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/**
 * Repository root, resolved as a real filesystem path.
 *
 * `new URL('../../', import.meta.url).pathname` looks equivalent but is not: it yields a
 * URL path, which on Windows is `/C:/Users/...` - a leading slash before the drive
 * letter. Next.js cannot resolve that, and rather than failing it silently skips the
 * standalone build, so `.next/standalone` never appears and the Docker COPY fails much
 * later with a confusing error. `fileURLToPath` produces the correct path everywhere.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  /**
   * Standalone output is what the production image ships, so it is the default. Next
   * traces the real module graph and emits a self-contained server, which is why
   * `outputFileTracingRoot` must point at the monorepo root: otherwise tracing stops at
   * apps/web and the workspace packages are left out of the bundle, failing at runtime
   * as a module-not-found inside the container.
   *
   * NEXT_DISABLE_STANDALONE=1 turns it off for local builds on Windows, where creating
   * symlinks needs elevated privileges and the trace-copy step fails with EPERM *after*
   * a successful compile. That is a platform limitation, not a code fault - the Docker
   * build runs on Linux and is unaffected - but without an escape hatch a Windows
   * contributor cannot verify their own build.
   */
  ...(process.env.NEXT_DISABLE_STANDALONE === '1'
    ? {}
    : { output: 'standalone', outputFileTracingRoot: repoRoot }),

  // Workspace packages ship TypeScript source, so Next must compile them itself.
  transpilePackages: [
    '@trip2world/shared',
    '@trip2world/types',
    '@trip2world/validation',
    '@trip2world/ui',
  ],

  poweredByHeader: false,

  eslint: {
    // Linting runs as its own CI step; a lint error should not fail a deploy build.
    ignoreDuringBuilds: true,
  },

  images: {
    // Avatars are the only remote images, and the validation schema restricts them to
    // https public hosts before they are ever stored.
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

export default withNextIntl(nextConfig);
