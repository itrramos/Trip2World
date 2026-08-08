import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  // Bundle the workspace packages so the runtime image does not need the pnpm
  // symlink farm resolved; leave native and engine-backed deps external.
  noExternal: [/^@trip2world\//],
  external: ['@prisma/client', 'argon2', 'ioredis', 'nodemailer'],
  dts: false,
});
