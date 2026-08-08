# Multi-stage image for the Node services: api, realtime, worker.
#
#   docker build -f infrastructure/docker/node.Dockerfile --build-arg APP=api .
#
# The build context is the repository root because pnpm workspaces need the lockfile and
# every workspace manifest to resolve a filtered install.
#
# NOTE ON LAYER CACHING: an earlier revision copied each workspace `package.json`
# individually to keep the (slow) install layer cached independently of source changes.
# That optimisation broke the build every time a package was added or removed, because
# COPY fails on a path that does not exist — and it failed at deploy time, not at
# development time. Copying the tree wholesale is a little slower on a source-only change
# and cannot break that way. The pnpm store cache mount recovers most of the difference.

FROM node:22.13-alpine AS base

# openssl: required by Prisma's query engine.
# libc6-compat: Alpine is musl; some native modules expect glibc symbols.
# tini: proper signal forwarding and zombie reaping.
RUN apk add --no-cache openssl libc6-compat tini

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# ──────────────────────────────────────────────────────────────────────────────
# Build
# ──────────────────────────────────────────────────────────────────────────────
FROM base AS builder

ARG APP
RUN test -n "$APP" || (echo "APP build arg is required" && false)

COPY . .

# --frozen-lockfile: fail rather than silently resolving a different dependency tree
# than the one that was tested.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Prisma needs DATABASE_URL present to parse the schema but never connects during
# `generate`. A dummy value keeps the build hermetic — no database required to build.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build?schema=public"

RUN pnpm --filter "@trip2world/${APP}..." build

# Drop dev dependencies from the tree that ships.
RUN pnpm prune --prod

# ──────────────────────────────────────────────────────────────────────────────
# Runtime
# ──────────────────────────────────────────────────────────────────────────────
FROM base AS runner

ARG APP
ENV APP=${APP}
ENV NODE_ENV=production
# Node does not read cgroup memory limits by default; without this, a container memory
# cap produces an OOM kill instead of a garbage collection.
ENV NODE_OPTIONS="--max-old-space-size=512"

RUN mkdir -p /app && chown -R node:node /app
WORKDIR /app

COPY --from=builder --chown=node:node /app/node_modules      ./node_modules
COPY --from=builder --chown=node:node /app/package.json      ./package.json
COPY --from=builder --chown=node:node /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder --chown=node:node /app/packages          ./packages
COPY --from=builder --chown=node:node /app/apps/${APP}       ./apps/${APP}

# Run unprivileged. `node` ships with the base image as uid 1000.
USER node

# tini reaps zombies and forwards SIGTERM, so `docker compose down` triggers the
# service's graceful shutdown (drain sockets, release Redis match locks) rather than a
# 10-second wait followed by SIGKILL — which would strand those locks until their TTL.
ENTRYPOINT ["/sbin/tini", "--"]

# Shell form so ${APP} is expanded at runtime.
CMD node apps/${APP}/dist/main.js
