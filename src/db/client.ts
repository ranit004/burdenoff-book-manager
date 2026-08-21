import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { loadEnv } from '../config/env';

/**
 * Single shared PrismaClient for the whole process.
 *
 * Prisma's documented best practice is one client per process: each client
 * owns a connection pool, so creating a new one per request (or per module
 * re-evaluation during hot reload) would exhaust Postgres connections.
 *
 * Bun's dev watcher re-imports modules on change, but the `globalThis` cache
 * keeps a single client (and its pool) alive across reloads — the same
 * pattern recommended for serverless and dev reload.
 */
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

function createPrismaClient(): PrismaClient {
  const { DATABASE_URL } = loadEnv();
  // Prisma 7 requires a driver adapter for SQL databases. PrismaPg wraps the
  // `pg` pool, so Prisma speaks SQL to Postgres directly through pg rather
  // than through its own binary engine.
  const adapter = new PrismaPg({ connectionString: DATABASE_URL });

  return new PrismaClient({ adapter });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
