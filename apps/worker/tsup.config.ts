import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  sourcemap: true,
  noExternal: [/^@trip2world\//],
  external: ["@prisma/client", "argon2", "ioredis", "bullmq", "nodemailer"],
  dts: false,
});