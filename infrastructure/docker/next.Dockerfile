# Multi-stage image for the Next.js applications: web, admin.
#
#   docker build -f infrastructure/docker/next.Dockerfile --build-arg APP=web .
#
# Uses Next.js `output: 'standalone'`, which traces the real module graph and emits a
# self-contained server — a few hundred MB smaller than shipping node_modules, and it
# means the runtime stage needs no package manager at all.

FROM node:22.13-alpine AS base

RUN apk add --no-cache libc6-compat tini

# Installed with npm, not corepack — see the note in node.Dockerfile. The corepack
# shipped in Node 22 images fails signature verification against npm's rotated registry
# keys, and it does so at runtime as well as at build time.
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN npm install -g pnpm@9.15.4 && pnpm --version

WORKDIR /app

# ──────────────────────────────────────────────────────────────────────────────
FROM base AS builder

ARG APP
RUN test -n "$APP" || (echo "APP build arg is required" && false)

# Next.js inlines NEXT_PUBLIC_* into the client bundle at BUILD time. Supplying them
# only as runtime environment is the classic cause of a production bundle that still
# points at localhost, so they are build args.
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_REALTIME_URL
ARG NEXT_PUBLIC_REALTIME_PATH=/rt
ARG NEXT_PUBLIC_BASE_PATH=

ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL}
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_REALTIME_URL=${NEXT_PUBLIC_REALTIME_URL}
ENV NEXT_PUBLIC_REALTIME_PATH=${NEXT_PUBLIC_REALTIME_PATH}
ENV NEXT_PUBLIC_BASE_PATH=${NEXT_PUBLIC_BASE_PATH}
ENV NEXT_TELEMETRY_DISABLED=1

# Copied wholesale rather than manifest-by-manifest: enumerating workspace package.json
# files means every new package breaks the image build until the Dockerfile is updated.
COPY . .

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

RUN pnpm --filter "@trip2world/${APP}..." build

# ──────────────────────────────────────────────────────────────────────────────
FROM base AS runner

ARG APP
ENV APP=${APP}
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nextjs \
 && adduser  --system --uid 1001 --ingroup nextjs nextjs

WORKDIR /app

# The standalone output already contains the traced node_modules and a server.js.
COPY --from=builder --chown=nextjs:nextjs /app/apps/${APP}/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/apps/${APP}/.next/static ./apps/${APP}/.next/static
COPY --from=builder --chown=nextjs:nextjs /app/apps/${APP}/public ./apps/${APP}/public

USER nextjs

ENTRYPOINT ["/sbin/tini", "--"]

CMD node apps/${APP}/server.js
