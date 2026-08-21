import { describe, expect, it } from 'bun:test';
import { bookmarkResolvers } from '../../src/graphql/resolvers/bookmark.resolvers';
import { ErrorCode, NotFoundError } from '../../src/lib/errors';
import {
  createPrismaStub,
  makeBookmark,
  makeFolder,
  type PrismaStub,
} from '../support/prisma-stub';

/**
 * Bookmark resolver tests.
 *
 * Every case asserts a real outcome — the value returned, the query built, or
 * the error thrown — and the mutation cases additionally assert that a rejected
 * request wrote nothing.
 */

const { Query, Mutation, Bookmark } = bookmarkResolvers;

/** Runs a resolver and returns the error it threw, failing if it did not throw. */
async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  let caught: unknown;
  let returned = false;
  try {
    await run();
    returned = true;
  } catch (error) {
    caught = error;
  }
  expect(returned).toBe(false);
  return caught;
}

function expectNotFound(error: unknown, entity: string, id: string): void {
  expect(error).toBeInstanceOf(NotFoundError);
  const graphqlError = error as NotFoundError;
  expect(graphqlError.extensions).toMatchObject({ code: ErrorCode.NOT_FOUND, entity, id });
  expect(graphqlError.message).toBe(`${entity} with id "${id}" was not found.`);
}

function expectNoWrites(stub: PrismaStub): void {
  expect(stub.writes()).toEqual([]);
}

// ---------------------------------------------------------------------------
// Query.bookmarks
// ---------------------------------------------------------------------------

describe('Query.bookmarks', () => {
  it('returns the rows as a connection and asks for one row beyond the page', async () => {
    const stub = createPrismaStub({
      bookmarks: [makeBookmark({ id: 'b1' }), makeBookmark({ id: 'b2' })],
    });

    const page = await Query.bookmarks({}, { take: 5 }, { prisma: stub.prisma });

    expect(page.items.map((b) => b.id)).toEqual(['b1', 'b2']);
    expect(page.nextCursor).toBeNull();
    expect(stub.argsOf('bookmark', 'findMany')).toMatchObject({ take: 6 });
  });

  it('trims the over-fetched row and reports the next cursor', async () => {
    const stub = createPrismaStub({
      bookmarks: [
        makeBookmark({ id: 'b1' }),
        makeBookmark({ id: 'b2' }),
        makeBookmark({ id: 'b3' }),
      ],
    });

    const page = await Query.bookmarks({}, { take: 2 }, { prisma: stub.prisma });

    expect(page.items.map((b) => b.id)).toEqual(['b1', 'b2']);
    expect(page.nextCursor).toBe('b2');
  });

  it('passes the cursor to Prisma with skip: 1', async () => {
    const stub = createPrismaStub({ bookmarks: [] });

    await Query.bookmarks({}, { cursor: 'b7' }, { prisma: stub.prisma });

    expect(stub.argsOf('bookmark', 'findMany')).toMatchObject({
      cursor: { id: 'b7' },
      skip: 1,
      take: 21,
    });
  });

  it('builds the filter clause from folderId and search', async () => {
    const stub = createPrismaStub({ bookmarks: [] });

    await Query.bookmarks({}, { folderId: 'f1', search: 'prisma' }, { prisma: stub.prisma });

    expect(stub.argsOf('bookmark', 'findMany')).toMatchObject({
      where: { folderId: 'f1', title: { contains: 'prisma', mode: 'insensitive' } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  });

  it('rejects take: 0 without querying at all', async () => {
    const stub = createPrismaStub({ bookmarks: [] });

    const error = await captureError(() =>
      Query.bookmarks({}, { take: 0 }, { prisma: stub.prisma }),
    );

    expect((error as NotFoundError).extensions).toMatchObject({
      code: ErrorCode.BAD_USER_INPUT,
      field: 'take',
    });
    // Not merely "no writes" — an invalid page size should cost no round trip.
    expect(stub.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Bookmark.folder
// ---------------------------------------------------------------------------

describe('Bookmark.folder', () => {
  it('resolves the owning folder', async () => {
    const stub = createPrismaStub({ folders: [makeFolder({ id: 'f9', name: 'Archive' })] });

    const folder = await Bookmark.folder(
      makeBookmark({ folderId: 'f9' }),
      {},
      {
        prisma: stub.prisma,
      },
    );

    expect(folder.name).toBe('Archive');
    expect(stub.argsOf('folder', 'findUnique')).toMatchObject({ where: { id: 'f9' } });
  });

  it('throws NOT_FOUND rather than returning null for a non-nullable field', async () => {
    // Unreachable while the foreign key holds, but it fails legibly if it ever
    // is reached — GraphQL's own "cannot return null for non-nullable field"
    // names no id and explains nothing.
    const stub = createPrismaStub({ folders: [] });

    const error = await captureError(() =>
      Bookmark.folder(makeBookmark({ folderId: 'gone' }), {}, { prisma: stub.prisma }),
    );

    expectNotFound(error, 'Folder', 'gone');
  });
});

// ---------------------------------------------------------------------------
// Mutation.createBookmark
// ---------------------------------------------------------------------------

describe('Mutation.createBookmark', () => {
  const input = { title: 'Prisma docs', url: 'https://prisma.io', folderId: 'f1' };

  it('creates the bookmark after confirming the folder exists', async () => {
    const stub = createPrismaStub({ existingFolderIds: ['f1'] });

    const created = await Mutation.createBookmark({}, { input }, { prisma: stub.prisma });

    expect(created.title).toBe('Prisma docs');
    expect(stub.argsOf('bookmark', 'create')).toEqual({
      data: { title: 'Prisma docs', url: 'https://prisma.io', folderId: 'f1' },
    });
  });

  it('throws NOT_FOUND and writes nothing when the folder is missing', async () => {
    const stub = createPrismaStub({ existingFolderIds: [] });

    const error = await captureError(() =>
      Mutation.createBookmark(
        {},
        { input: { ...input, folderId: 'nope' } },
        {
          prisma: stub.prisma,
        },
      ),
    );

    expectNotFound(error, 'Folder', 'nope');
    expectNoWrites(stub);
  });

  it('rejects invalid input before looking the folder up', async () => {
    const stub = createPrismaStub({ existingFolderIds: ['f1'] });

    await captureError(() =>
      Mutation.createBookmark(
        {},
        { input: { ...input, url: 'javascript:alert(1)' } },
        {
          prisma: stub.prisma,
        },
      ),
    );

    // Malformed input should not cost a database round trip.
    expect(stub.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Mutation.updateBookmark
// ---------------------------------------------------------------------------

describe('Mutation.updateBookmark', () => {
  it('sends only the supplied fields', async () => {
    const stub = createPrismaStub({ existingBookmarkIds: ['b1'] });

    const updated = await Mutation.updateBookmark(
      {},
      { id: 'b1', input: { title: '  Renamed  ' } },
      { prisma: stub.prisma },
    );

    expect(updated.title).toBe('Renamed');
    expect(stub.argsOf('bookmark', 'update')).toEqual({
      where: { id: 'b1' },
      data: { title: 'Renamed' },
    });
  });

  it('throws NOT_FOUND and writes nothing for a missing bookmark', async () => {
    const stub = createPrismaStub({ existingBookmarkIds: [] });

    const error = await captureError(() =>
      Mutation.updateBookmark({}, { id: 'nope', input: { title: 'T' } }, { prisma: stub.prisma }),
    );

    expectNotFound(error, 'Bookmark', 'nope');
    expectNoWrites(stub);
  });

  it('rejects an empty update without touching the database', async () => {
    const stub = createPrismaStub({ existingBookmarkIds: ['b1'] });

    const error = await captureError(() =>
      Mutation.updateBookmark({}, { id: 'b1', input: {} }, { prisma: stub.prisma }),
    );

    expect((error as NotFoundError).extensions).toMatchObject({ code: ErrorCode.BAD_USER_INPUT });
    expect(stub.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Mutation.deleteBookmark
// ---------------------------------------------------------------------------

describe('Mutation.deleteBookmark', () => {
  it('deletes and returns true', async () => {
    const stub = createPrismaStub({ existingBookmarkIds: ['b1'] });

    const result = await Mutation.deleteBookmark({}, { id: 'b1' }, { prisma: stub.prisma });

    expect(result).toBe(true);
    expect(stub.argsOf('bookmark', 'delete')).toEqual({ where: { id: 'b1' } });
  });

  it('throws NOT_FOUND instead of returning false', async () => {
    // The return value must stay unambiguous: if it returns at all, the
    // bookmark is gone.
    const stub = createPrismaStub({ existingBookmarkIds: [] });

    const error = await captureError(() =>
      Mutation.deleteBookmark({}, { id: 'nope' }, { prisma: stub.prisma }),
    );

    expectNotFound(error, 'Bookmark', 'nope');
    expectNoWrites(stub);
  });
});

// ---------------------------------------------------------------------------
// Mutation.moveBookmark
// ---------------------------------------------------------------------------

describe('Mutation.moveBookmark', () => {
  it('moves the bookmark once both rows are confirmed', async () => {
    const stub = createPrismaStub({ existingBookmarkIds: ['b1'], existingFolderIds: ['f2'] });

    await Mutation.moveBookmark({}, { id: 'b1', folderId: 'f2' }, { prisma: stub.prisma });

    expect(stub.argsOf('bookmark', 'update')).toEqual({
      where: { id: 'b1' },
      data: { folderId: 'f2' },
    });
  });

  it('checks both rows concurrently, before the write', async () => {
    const stub = createPrismaStub({ existingBookmarkIds: ['b1'], existingFolderIds: ['f2'] });

    await Mutation.moveBookmark({}, { id: 'b1', folderId: 'f2' }, { prisma: stub.prisma });

    expect(stub.calls.map((c) => `${c.model}.${c.method}`)).toEqual([
      'bookmark.findUnique',
      'folder.findUnique',
      'bookmark.update',
    ]);
  });

  it('throws NOT_FOUND for a missing target folder', async () => {
    const stub = createPrismaStub({ existingBookmarkIds: ['b1'], existingFolderIds: [] });

    const error = await captureError(() =>
      Mutation.moveBookmark({}, { id: 'b1', folderId: 'nope' }, { prisma: stub.prisma }),
    );

    expectNotFound(error, 'Folder', 'nope');
    expectNoWrites(stub);
  });

  it('names the bookmark first when both are missing', async () => {
    // Both lookups run concurrently, so the reported error must come from a
    // fixed inspection order rather than from whichever query resolved first.
    const stub = createPrismaStub({ existingBookmarkIds: [], existingFolderIds: [] });

    const error = await captureError(() =>
      Mutation.moveBookmark({}, { id: 'nope', folderId: 'alsonope' }, { prisma: stub.prisma }),
    );

    expectNotFound(error, 'Bookmark', 'nope');
    expectNoWrites(stub);
  });
});
