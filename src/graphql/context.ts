import type { PrismaClient } from '../generated/prisma/client';

/**
 * The context every resolver receives.
 *
 * Prisma arrives through the context rather than being imported directly by
 * each resolver module. That is what makes the resolvers unit-testable: a test
 * passes in a stub, and no resolver has a hidden dependency on a live database.
 * src/server.ts is the only place that injects the real client.
 */
export interface GraphQLContext {
  readonly prisma: PrismaClient;
}
