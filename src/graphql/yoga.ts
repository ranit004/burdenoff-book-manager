import { GraphQLError } from 'graphql';
import { createYoga, maskError, type YogaServerInstance } from 'graphql-yoga';
import type { PrismaClient } from '../generated/prisma/client';
import { ErrorCode } from '../lib/errors';
import type { GraphQLContext } from './context';
import { schema } from './schema';

/**
 * Builds the Yoga server.
 *
 * Separated from src/server.ts, which only binds a port, so tests can drive a
 * fully-configured server — masking, scalars, argument coercion and all — over
 * `fetch` without opening a socket.
 */

/**
 * Error codes a client is allowed to see.
 *
 * Everything not listed here is replaced with a generic message, so an
 * unexpected failure cannot leak a stack trace, a table name, or the connection
 * string sitting in a database error.
 *
 * This is an allow-list rather than a reliance on Yoga's default, which passes
 * through any GraphQLError whose `originalError` chain bottoms out. That default
 * would carry our errors correctly, but it would equally carry a GraphQLError
 * raised deep inside a dependency — and such an error is exactly the kind most
 * likely to quote internals. Naming the codes we intend to expose keeps that
 * decision explicit and auditable instead of emergent.
 */
const CLIENT_FACING_CODES: ReadonlySet<string> = new Set<string>(Object.values(ErrorCode));

function isClientFacing(error: unknown): boolean {
  if (!(error instanceof GraphQLError)) {
    return false;
  }
  const code = error.extensions['code'];
  return typeof code === 'string' && CLIENT_FACING_CODES.has(code);
}

/**
 * True for errors raised by GraphQL's own request handling rather than by a
 * resolver: syntax errors, validation failures, variable coercion failures.
 *
 * The discriminator is `path`. graphql-js attaches the response path to every
 * error that escapes a resolver, and cannot attach one to an error raised before
 * or around execution — so an absent path means no resolver, and therefore no
 * database or application internals, was involved.
 *
 * These must reach the client verbatim. They are the messages that tell an API
 * consumer their query has a typo or their variable is the wrong type; replacing
 * them with "Unexpected error." would make the API undebuggable while protecting
 * nothing, since their content is derived entirely from the request and the
 * published schema.
 */
function isProtocolError(error: unknown): boolean {
  return error instanceof GraphQLError && error.path === undefined;
}

/**
 * Masks an error that is neither allow-listed nor a protocol error.
 *
 * Yoga's `maskError` is reused rather than reimplemented, because it also
 * carries `extensions.http` through (which drives the response status) and
 * serializes the cause in development. But it returns any GraphQLError whose
 * `originalError` chain bottoms out completely untouched — so handing it a
 * dependency's GraphQLError directly would publish that error verbatim, which
 * is the leak this allow-list exists to prevent.
 *
 * So the error is first re-wrapped with a plain `Error` as its cause. That
 * leaves every field Yoga inspects intact — nodes, source, positions, path and
 * extensions, so locations and status handling still work — while defeating the
 * one short-circuit that would otherwise skip masking.
 */
function forceMask(error: unknown, message: string, isDev?: boolean): Error {
  if (!(error instanceof GraphQLError)) {
    // Yoga already masks anything that is not a GraphQLError.
    return maskError(error, message, isDev);
  }

  const neutralized = new GraphQLError(error.message, {
    nodes: error.nodes,
    source: error.source,
    positions: error.positions,
    path: error.path,
    extensions: error.extensions,
    originalError: new Error(error.message),
  });

  return maskError(neutralized, message, isDev);
}

export interface GraphQLServerOptions {
  readonly prisma: PrismaClient;
  /** Enables GraphiQL and lets masked errors carry their original cause. */
  readonly isDev?: boolean;
  /**
   * Server-side error logging. On by default — a masked error must still be
   * recorded somewhere, or an outage leaves no trace. Tests that deliberately
   * trigger internal failures turn it off so expected noise (and the fake
   * credentials they assert on) stay out of the output.
   */
  readonly logging?: boolean;
}

export function createGraphQLServer({
  prisma,
  isDev = false,
  logging = true,
}: GraphQLServerOptions): YogaServerInstance<Record<string, never>, GraphQLContext> {
  return createYoga<Record<string, never>, GraphQLContext>({
    schema,
    logging,

    /**
     * Prisma is injected per request rather than imported by the resolvers.
     *
     * This is the seam that makes the resolvers testable: a test supplies its
     * own client (or a stub) through this same context, so no resolver ever
     * reaches for a module-level singleton it cannot be separated from.
     */
    context: () => ({ prisma }),

    maskedErrors: {
      isDev,
      errorMessage: 'Unexpected error.',
      maskError: (error: unknown, message: string, dev?: boolean): Error =>
        isClientFacing(error) || isProtocolError(error)
          ? (error as Error)
          : forceMask(error, message, dev),
    },

    graphiql: isDev,
    landingPage: false,
    graphqlEndpoint: '/graphql',
  });
}
