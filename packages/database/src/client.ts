import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Prisma client singleton.
 *
 * Next.js dev-mode hot reloading re-evaluates modules on every edit; without caching the
 * instance on `globalThis` each reload would open a fresh connection pool and exhaust
 * Postgres within a few saves. In production the module is evaluated once and the guard
 * is a no-op.
 */

declare global {
  // eslint-disable-next-line no-var
  var __trip2worldPrisma: PrismaClient | undefined;
}

export interface CreatePrismaOptions {
  databaseUrl?: string;
  /** Emit query-level logs. Never enable in production — queries include parameters. */
  logQueries?: boolean;
}

export function createPrismaClient(options: CreatePrismaOptions = {}): PrismaClient {
  const { databaseUrl, logQueries = false } = options;

  const log: Prisma.LogLevel[] = logQueries
    ? ['query', 'warn', 'error']
    : ['warn', 'error'];

  return new PrismaClient({
    log,
    ...(databaseUrl ? { datasources: { db: { url: databaseUrl } } } : {}),
  });
}

export const prisma: PrismaClient =
  globalThis.__trip2worldPrisma ??
  createPrismaClient({
    logQueries: process.env.PRISMA_LOG_QUERIES === 'true' && process.env.NODE_ENV !== 'production',
  });

if (process.env.NODE_ENV !== 'production') {
  globalThis.__trip2worldPrisma = prisma;
}

/** Liveness probe used by `/ready`. Cheap enough to run on every check. */
export async function checkDatabase(client: PrismaClient = prisma): Promise<boolean> {
  try {
    await client.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export async function disconnect(client: PrismaClient = prisma): Promise<void> {
  await client.$disconnect();
}

/* -------------------------------------------------------------------------- */
/* Error helpers                                                               */
/* -------------------------------------------------------------------------- */

/** True when the error is a unique-constraint violation, optionally on a given field. */
export function isUniqueConstraintError(error: unknown, field?: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== 'P2002') return false;
  if (!field) return true;

  const target = error.meta?.target;
  if (Array.isArray(target)) return target.includes(field);
  return typeof target === 'string' && target.includes(field);
}

/** True when a `findUniqueOrThrow`/`update` failed because the row does not exist. */
export function isRecordNotFoundError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}

export { Prisma, PrismaClient };
export type * from '@prisma/client';
