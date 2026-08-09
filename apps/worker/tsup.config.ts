import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  sourcemap: true,
  noExternal: [/^@trip2world\//],
  // The worker does not hash passwords; argon2 was listed here and never imported.
  external: ["@prisma/client", "ioredis", "bullmq", "nodemailer"],
  dts: false,
});