import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createTestApi } from '../support/integration-api';

/**
 * End-to-end API tests against real Postgres.
 *
 * Every step here goes over HTTP through the configured Yoga server, so this is
 * the suite that would catch a schema/resolver mismatch, a broken scalar, a
 * column the migration never created, or a constraint the code assumes but the
 * database does not have.
 */

const api = createTestApi();

interface Folder {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

interface Bookmark {
  id: string;
  title: string;
  url: string;
  tags: string[];
  folderId: string;
  createdAt: string;
  updatedAt: string;
}

const CREATE_FOLDER = `
  mutation ($name: String!) {
    createFolder(name: $name) { id name createdAt updatedAt }
  }
`;

const CREATE_BOOKMARK = `
  mutation ($input: CreateBookmarkInput!) {
    createBookmark(input: $input) { id title url tags folderId createdAt updatedAt }
  }
`;

beforeAll(async () => {
  await api.requireDatabase();
});

afterAll(async () => {
  await api.cleanup();
});

async function newFolder(suffix: string): Promise<Folder> {
  const data = await api.gql<{ createFolder: Folder }>(CREATE_FOLDER, {
    name: api.name(suffix),
  });
  return data.createFolder;
}

/** Prisma's "foreign key constraint violated". */
const FOREIGN_KEY_VIOLATION = 'P2003';

/**
 * Awaits an operation expected to fail and returns its error.
 *
 * Not `expect(...).rejects`: Prisma hands back a PrismaPromise, a thenable that
 * is not a Promise instance, and Bun's matcher rejects it outright.
 */
async function rejectionOf(operation: PromiseLike<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the operation to fail, but it succeeded.');
}

/** Asserts the database refused the write for the specific reason expected. */
function expectPrismaError(error: unknown, code: string): void {
  // Checking the code, not just "something threw" — a connection drop or a
  // typo'd column would otherwise satisfy the assertion and prove nothing
  // about the constraint under test.
  expect(error).toBeInstanceOf(Error);
  expect((error as { code?: unknown }).code).toBe(code);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('the full bookmark lifecycle over HTTP', () => {
  it('creates, reads, updates, moves and deletes', async () => {
    const reading = await newFolder('lifecycle-reading');
    const archive = await newFolder('lifecycle-archive');

    expect(reading.id).toMatch(/^[a-z0-9]+$/);
    expect(reading.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const created = (
      await api.gql<{ createBookmark: Bookmark }>(CREATE_BOOKMARK, {
        input: {
          title: '  Prisma docs  ',
          url: '  https://www.prisma.io/docs  ',
          folderId: reading.id,
          tags: ['  db  ', 'orm'],
        },
      })
    ).createBookmark;

    // Trimming happened before the insert, not on the way out.
    expect(created.title).toBe('Prisma docs');
    expect(created.url).toBe('https://www.prisma.io/docs');
    expect(created.tags).toEqual(['db', 'orm']);
    expect(created.folderId).toBe(reading.id);

    // Nested read: folder -> bookmarks -> folder, which exercises both the
    // forward field resolver and the back-reference.
    const nested = await api.gql<{
      folder: { name: string; bookmarks: { id: string; folder: { id: string } }[] } | null;
    }>(`query ($id: ID!) { folder(id: $id) { name bookmarks { id folder { id } } } }`, {
      id: reading.id,
    });

    expect(nested.folder?.bookmarks).toHaveLength(1);
    expect(nested.folder?.bookmarks[0]?.id).toBe(created.id);
    expect(nested.folder?.bookmarks[0]?.folder.id).toBe(reading.id);

    // Partial update: url and tags must survive untouched. A stub echoes back
    // whatever it was handed, so only a real round trip proves this.
    const updated = (
      await api.gql<{ updateBookmark: Bookmark }>(
        `mutation ($id: ID!) {
           updateBookmark(id: $id, input: { title: "Prisma docs (v7)" }) {
             id title url tags createdAt updatedAt
           }
         }`,
        { id: created.id },
      )
    ).updateBookmark;

    expect(updated.title).toBe('Prisma docs (v7)');
    expect(updated.url).toBe(created.url);
    expect(updated.tags).toEqual(['db', 'orm']);
    expect(updated.createdAt).toBe(created.createdAt);
    // @updatedAt is a Prisma-managed column; if it stopped advancing, nothing
    // else in the response would show it.
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(created.updatedAt).getTime(),
    );

    const moved = (
      await api.gql<{ moveBookmark: Bookmark }>(
        `mutation ($id: ID!, $folderId: ID!) {
           moveBookmark(id: $id, folderId: $folderId) { id folderId }
         }`,
        { id: created.id, folderId: archive.id },
      )
    ).moveBookmark;

    expect(moved.folderId).toBe(archive.id);

    // The move is visible from both sides of the relation.
    const bothSides = await api.gql<{
      from: { bookmarks: { id: string }[] } | null;
      to: { bookmarks: { id: string }[] } | null;
    }>(
      `query ($from: ID!, $to: ID!) {
         from: folder(id: $from) { bookmarks { id } }
         to: folder(id: $to) { bookmarks { id } }
       }`,
      { from: reading.id, to: archive.id },
    );

    expect(bothSides.from?.bookmarks).toEqual([]);
    expect(bothSides.to?.bookmarks.map((b) => b.id)).toEqual([created.id]);

    const deleted = await api.gql<{ deleteBookmark: boolean }>(
      `mutation ($id: ID!) { deleteBookmark(id: $id) }`,
      { id: created.id },
    );
    expect(deleted.deleteBookmark).toBe(true);

    // Deleting again is NOT_FOUND, never a silent `false`.
    const again = await api.raw(`mutation ($id: ID!) { deleteBookmark(id: $id) }`, {
      id: created.id,
    });
    expect(again.errors?.[0]?.extensions).toMatchObject({
      code: 'NOT_FOUND',
      entity: 'Bookmark',
      id: created.id,
    });
    expect(await api.prisma.bookmark.count({ where: { id: created.id } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Defaults the database supplies
// ---------------------------------------------------------------------------

describe('column defaults', () => {
  it('stores an empty tag list, not null, when tags are omitted', async () => {
    const folder = await newFolder('defaults');

    const created = (
      await api.gql<{ createBookmark: Bookmark }>(CREATE_BOOKMARK, {
        input: { title: 'No tags', url: 'https://example.com', folderId: folder.id },
      })
    ).createBookmark;

    expect(created.tags).toEqual([]);

    // Read back through a fresh query: the schema promises [String!]!, so a
    // null column here would surface as a non-nullable-field error later.
    const row = await api.prisma.bookmark.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.tags).toEqual([]);
  });

  it('clears tags when an explicit empty list is sent', async () => {
    const folder = await newFolder('clear-tags');

    const created = (
      await api.gql<{ createBookmark: Bookmark }>(CREATE_BOOKMARK, {
        input: { title: 'Tagged', url: 'https://example.com', folderId: folder.id, tags: ['a'] },
      })
    ).createBookmark;
    expect(created.tags).toEqual(['a']);

    // `[]` is a real update, distinct from omitting the field entirely.
    const updated = (
      await api.gql<{ updateBookmark: Bookmark }>(
        `mutation ($id: ID!) { updateBookmark(id: $id, input: { tags: [] }) { tags } }`,
        { id: created.id },
      )
    ).updateBookmark;

    expect(updated.tags).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Constraints the database enforces
// ---------------------------------------------------------------------------

describe('referential integrity', () => {
  it('rejects a bookmark in a nonexistent folder with NOT_FOUND', async () => {
    const response = await api.raw(CREATE_BOOKMARK, {
      input: { title: 'Orphan', url: 'https://example.com', folderId: 'does-not-exist' },
    });

    expect(response.errors?.[0]?.extensions).toMatchObject({
      code: 'NOT_FOUND',
      entity: 'Folder',
      id: 'does-not-exist',
    });
    expect(await api.prisma.bookmark.count({ where: { title: 'Orphan' } })).toBe(0);
  });

  it('is still protected by the foreign key when the resolver check is bypassed', async () => {
    // The resolver's existence check exists for the error message. The database
    // constraint is the actual guarantee, and this asserts it is really there —
    // a migration that quietly dropped the FK would pass every other test.
    const error = await rejectionOf(
      api.prisma.bookmark.create({
        data: { title: 'Orphan (direct)', url: 'https://example.com', folderId: 'does-not-exist' },
      }),
    );

    expectPrismaError(error, FOREIGN_KEY_VIOLATION);
    expect(await api.prisma.bookmark.count({ where: { title: 'Orphan (direct)' } })).toBe(0);
  });

  it('refuses to delete a folder that still has bookmarks', async () => {
    // onDelete: Restrict. Not reachable through the API today (there is no
    // deleteFolder mutation), which is exactly why it is worth pinning: the
    // behaviour a future mutation would inherit is asserted before it exists.
    const folder = await newFolder('restrict');
    await api.gql(CREATE_BOOKMARK, {
      input: { title: 'Held', url: 'https://example.com', folderId: folder.id },
    });

    const error = await rejectionOf(api.prisma.folder.delete({ where: { id: folder.id } }));

    expectPrismaError(error, FOREIGN_KEY_VIOLATION);
    expect(await api.prisma.folder.count({ where: { id: folder.id } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Validation, end to end
// ---------------------------------------------------------------------------

describe('validation reaches the client and blocks the write', () => {
  it('rejects a javascript: URL', async () => {
    const folder = await newFolder('xss');

    const response = await api.raw(CREATE_BOOKMARK, {
      input: { title: 'Bad', url: 'javascript:alert(1)', folderId: folder.id },
    });

    expect(response.errors?.[0]?.extensions).toMatchObject({
      code: 'BAD_USER_INPUT',
      field: 'url',
    });
    // A stored javascript: URL is a stored-XSS payload for any client that
    // renders it as a link, so "did not persist" is the assertion that matters.
    expect(await api.prisma.bookmark.count({ where: { folderId: folder.id } })).toBe(0);
  });

  it('rejects an update with no fields', async () => {
    const folder = await newFolder('empty-update');
    const created = (
      await api.gql<{ createBookmark: Bookmark }>(CREATE_BOOKMARK, {
        input: { title: 'Unchanged', url: 'https://example.com', folderId: folder.id },
      })
    ).createBookmark;

    const response = await api.raw(
      `mutation ($id: ID!) { updateBookmark(id: $id, input: {}) { id } }`,
      { id: created.id },
    );

    expect(response.errors?.[0]?.message).toBe(
      'Provide at least one field to update (title, url or tags).',
    );

    const row = await api.prisma.bookmark.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.title).toBe('Unchanged');
    expect(row.updatedAt.getTime()).toBe(new Date(created.updatedAt).getTime());
  });

  it('rejects a blank folder name', async () => {
    const response = await api.raw(CREATE_FOLDER, { name: '   ' });

    expect(response.errors?.[0]?.extensions).toMatchObject({
      code: 'BAD_USER_INPUT',
      field: 'name',
    });
  });
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe('folders query', () => {
  it('returns folders alphabetically, regardless of insertion order', async () => {
    // Created out of order on purpose; the sort has to come from SQL.
    await newFolder('order-zeta');
    await newFolder('order-alpha');
    await newFolder('order-mid');

    const data = await api.gql<{ folders: { name: string }[] }>(`{ folders { name } }`);

    // Scoped to this run's fixtures: the dev database may hold anything else.
    const mine = data.folders
      .map((f) => f.name)
      .filter((name) => name.startsWith(`${api.ns}-order-`));

    expect(mine).toEqual([api.name('order-alpha'), api.name('order-mid'), api.name('order-zeta')]);
  });
});
