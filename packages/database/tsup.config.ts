import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  // Prisma's generated client must stay external — it resolves engine binaries at runtime.
  external: ['@prisma/client', '@trip2world/types', '@trip2world/shared'],
});
