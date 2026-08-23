import { describe, expect, it } from 'bun:test';
import { GraphQLError } from 'graphql';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { createGraphQLServer } from '../../src/graphql/yoga';

/**
 * Error-masking regression tests.
 *
 * These drive the fully-configured Yoga server over `fetch`, so HTTP handling,
 * parsing, validation, variable coercion, execution and masking all really run.
 * Nothing here stubs a resolver.
 *
 * The property under test has two directions, and both matter:
 *
 *   - Domain errors and GraphQL's own protocol errors must reach the client
 *     intact, or the API is undebuggable.
 *   - Everything else must be replaced, or an internal failure publishes
 *     credentials and schema details.
 *
 * A permissive bug in the first direction is a security hole; a strict bug in
 * the second is a usability one. Both are easy to introduce while fixing the
 * other, which is why they are pinned here.
 */

/** Stands in for a credential that must never appear in a response. */
const SECRET = 'postgresql://postgres:sup3rs3cret@localhost:5432/bookmark_manager';

type Mode = 'ok' | 'throws-plain-error' | 'throws-graphql-error';

function serverThatThrows(mode: Mode): ReturnType<typeof createGraphQLServer> {
  const stub = {
    folder: {
      findMany: () => {
        if (mode === 'throws-plain-error') {
          // How a driver or client library typically fails.
          throw new Error(`connect ECONNREFUSED ${SECRET}`);
        }
        if (mode === 'throws-graphql-error') {
          // A dependency that happens to throw GraphQLError. Yoga's default
          // masking passes this through untouched, so it is the case the
          // allow-list exists for.
          throw new GraphQLError(`Datasource error: ${SECRET}`);
        }
        return Promise.resolve([]);
      },
      findUnique: () => Promise.resolve(null),
    },
    bookmark: {
      findUnique: () => Promise.resolve(null),
      findMany: () => Promise.resolve([]),
    },
  };

  // logging: false because these tests deliberately trigger internal errors;
  // logging them would fill the output with expected stack traces containing
  // the fake credential above.
  return createGraphQLServer({
    prisma: stub as unknown as PrismaClient,
    isDev: false,
    logging: false,
  });
}

interface GraphQLResponseBody {
  data?: unknown;
  errors?: { message: string; extensions?: Record<string, unknown> }[];
}

async function post(
  mode: Mode,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ status: number; raw: string; body: GraphQLResponseBody }> {
  const response = await serverThatThrows(mode).fetch('http://localhost/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });

  const raw = await response.text();
  return { status: response.status, raw, body: JSON.parse(raw) as GraphQLResponseBody };
}

describe('errors the client is meant to see', () => {
  it('surfaces NOT_FOUND with the entity and id that were not found', async () => {
    const { body } = await post(
      'ok',
      'mutation { moveBookmark(id: "nope", folderId: "f1") { id } }',
    );

    expect(body.errors?.[0]?.message).toBe('Bookmark with id "nope" was not found.');
    expect(body.errors?.[0]?.extensions).toMatchObject({
      code: 'NOT_FOUND',
      entity: 'Bookmark',
      id: 'nope',
    });
  });

  it('surfaces BAD_USER_INPUT with the offending field', async () => {
    const { body } = await post('ok', 'mutation { createFolder(name: "  ") { id } }');

    expect(body.errors?.[0]?.message).toBe('name must not be empty or only whitespace.');
    expect(body.errors?.[0]?.extensions).toMatchObject({ code: 'BAD_USER_INPUT', field: 'name' });
  });

  it('surfaces BAD_USER_INPUT raised during pagination', async () => {
    const { body } = await post('ok', '{ bookmarks(take: 0) { nextCursor } }');

    expect(body.errors?.[0]?.message).toBe('take must be at least 1 (received 0).');
    expect(body.errors?.[0]?.extensions).toMatchObject({ code: 'BAD_USER_INPUT', field: 'take' });
  });
});

describe('errors that must be masked', () => {
  it('masks a plain Error and does not leak its message', async () => {
    const { raw, body } = await post('throws-plain-error', '{ folders { id } }');

    expect(raw).not.toContain('sup3rs3cret');
    expect(raw).not.toContain('ECONNREFUSED');
    expect(body.errors?.[0]?.message).toBe('Unexpected error.');
    expect(body.errors?.[0]?.extensions).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });

  it('masks a GraphQLError thrown by a dependency', async () => {
    // Regression: Yoga's default maskError returns any GraphQLError whose
    // originalError chain bottoms out, so delegating to it published this
    // verbatim. The masking path must not hand this case to the default.
    const { raw, body } = await post('throws-graphql-error', '{ folders { id } }');

    expect(raw).not.toContain('sup3rs3cret');
    expect(raw).not.toContain('Datasource error');
    expect(body.errors?.[0]?.message).toBe('Unexpected error.');
  });

  it('keeps the response path so the client still knows which field failed', async () => {
    const { raw } = await post('throws-plain-error', '{ folders { id } }');
    expect(raw).toContain('"path":["folders"]');
  });
});

describe("GraphQL's own protocol errors must still surface", () => {
  it('reports an unknown field', async () => {
    const { body } = await post('ok', '{ folders { nope } }');

    expect(body.errors?.[0]?.message).toContain('Cannot query field "nope" on type "Folder"');
    expect(body.errors?.[0]?.extensions).toMatchObject({ code: 'GRAPHQL_VALIDATION_FAILED' });
  });

  it('reports a syntax error', async () => {
    // Regression: masking these leaves the API undebuggable while protecting
    // nothing, since the message derives only from the request and the schema.
    const { body } = await post('ok', '{ folders {');

    expect(body.errors?.[0]?.message).toContain('Syntax Error');
    expect(body.errors?.[0]?.extensions).toMatchObject({ code: 'GRAPHQL_PARSE_FAILED' });
  });

  it('reports a variable of the wrong type, with HTTP 400', async () => {
    const { status, body } = await post(
      'ok',
      'query Q($t: Int) { bookmarks(take: $t) { nextCursor } }',
      {
        t: 'not-an-int',
      },
    );

    expect(status).toBe(400);
    expect(body.errors?.[0]?.message).toContain('Int cannot represent non-integer value');
  });
});

describe('the happy path still works', () => {
  it('returns data for a valid query', async () => {
    const { status, body } = await post('ok', '{ folders { id name } }');

    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data).toEqual({ folders: [] });
  });
});
