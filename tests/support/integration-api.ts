import { PrismaPg } from '@prisma/adapter-pg';
import { loadEnv } from '../../src/config/env';
import { PrismaClient } from '../../src/generated/prisma/client';
import { createGraphQLServer } from '../../src/graphql/yoga';

/**
 * Harness for the integration tests.
 *
 * These run the whole stack for real: HTTP request in, parsing, validation,
 * variable coercion, execution, Prisma, Postgres, and the response back out.
 * Nothing is stubbed. That is the point — the unit tests already pin the query
 * objects the resolvers build, and a stub can never say whether Postgres agrees
 * with them. Only a real database can confirm that `mode: 'insensitive'` is
 * actually case-insensitive, that a cursor skips exactly one row, that
 * `@default([])` yields an empty array rather than null, or that the foreign
 * key is enforced when the application-level check is bypassed.
 *
 * Two rules these tests follow, because a shared dev database is not pristine:
 *
 *   1. Every fixture is namespaced with a per-run id, and every assertion is
 *      scoped to that namespace. A test never asserts on a total row count or
 *      assumes it owns the table.
 *   2. Cleanup deletes only what the run created, matched by that namespace.
 *
 * The alternative — truncating between tests — is faster to write and destroys
 * whatever the developer had in their dev database.
 */

/** Own client rather than the app singleton, so each file owns its pool and can close it. */
export function createTestPrisma(): PrismaClient {
  const { DATABASE_URL } = loadEnv();
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) });
}

/**
 * Fails with an actionable message instead of a driver stack trace.
 *
 * `count()` rather than `SELECT 1`: it proves the connection AND that the
 * migration has been applied, which are the two things that actually go wrong.
 */
export async function requireDatabase(prisma: PrismaClient): Promise<void> {
  try {
    await prisma.folder.count();
  } catch (cause) {
    throw new Error(
      'Integration tests need Postgres with migrations applied. Run:\n' +
        '  docker compose up -d\n' +
        '  bun run db:migrate\n' +
        `Original error: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

export interface GraphQLResponse<T> {
  status: number;
  data: T | null;
  errors?: { message: string; path?: (string | number)[]; extensions?: Record<string, unknown> }[];
}

export interface TestApi {
  readonly prisma: PrismaClient;
  /** Unique per run; prefixes every fixture name so assertions can be scoped. */
  readonly ns: string;
  /** Namespaces a folder name. */
  name: (suffix: string) => string;
  /** Executes an operation over HTTP and returns status, data and errors. */
  raw: <T>(query: string, variables?: Record<string, unknown>) => Promise<GraphQLResponse<T>>;
  /** Same, but throws if the response carried errors. For happy-path steps. */
  gql: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;
  /** Deletes every row this run created, then closes the pool. */
  cleanup: () => Promise<void>;
}

export function createTestApi(): TestApi {
  const prisma = createTestPrisma();
  const yoga = createGraphQLServer({ prisma, isDev: false, logging: false });
  const ns = `it-${crypto.randomUUID().slice(0, 8)}`;

  const name = (suffix: string): string => `${ns}-${suffix}`;

  async function raw<T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<GraphQLResponse<T>> {
    const response = await yoga.fetch('http://localhost/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });

    const body = (await response.json()) as { data?: T; errors?: GraphQLResponse<T>['errors'] };
    return { status: response.status, data: body.data ?? null, errors: body.errors };
  }

  async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const response = await raw<T>(query, variables);
    if (response.errors !== undefined || response.data === null) {
      throw new Error(
        `Expected a successful operation, got: ${JSON.stringify(response.errors ?? response)}`,
      );
    }
    return response.data;
  }

  async function cleanup(): Promise<void> {
    // Bookmarks first: the relation is onDelete: Restrict, so Postgres refuses
    // to drop a folder that still has any.
    await prisma.bookmark.deleteMany({ where: { folder: { name: { startsWith: ns } } } });
    await prisma.folder.deleteMany({ where: { name: { startsWith: ns } } });
    await prisma.$disconnect();
  }

  return { prisma, ns, name, raw, gql, cleanup };
}
