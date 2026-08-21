import { describe, expect, it } from 'bun:test';
import { folderResolvers } from '../../src/graphql/resolvers/folder.resolvers';
import { ErrorCode, ValidationError } from '../../src/lib/errors';
import { createPrismaStub, makeBookmark, makeFolder } from '../support/prisma-stub';

/**
 * Folder resolver tests, driven through the same injected Prisma stub as the
 * bookmark ones.
 */

const { Query, Mutation, Folder } = folderResolvers;

describe('Query.folders', () => {
  it('returns the folders ordered by name', async () => {
    const stub = createPrismaStub({
      folders: [
        makeFolder({ id: 'f1', name: 'Archive' }),
        makeFolder({ id: 'f2', name: 'Reading' }),
      ],
    });

    const folders = await Query.folders({}, {}, { prisma: stub.prisma });

    expect(folders.map((f) => f.name)).toEqual(['Archive', 'Reading']);
    // The stub returns rows verbatim, so the ordering above only proves the
    // fixture order. What is actually under test is that the resolver asks the
    // database to sort — sorting in SQL, not in JS, is what keeps working once
    // pagination is involved.
    expect(stub.argsOf('folder', 'findMany')).toEqual({ orderBy: { name: 'asc' } });
  });
});

describe('Query.folder', () => {
  it('returns the folder when it exists', async () => {
    const stub = createPrismaStub({ folders: [makeFolder({ id: 'f1', name: 'Reading' })] });

    const folder = await Query.folder({}, { id: 'f1' }, { prisma: stub.prisma });

    expect(folder?.name).toBe('Reading');
    expect(stub.argsOf('folder', 'findUnique')).toEqual({ where: { id: 'f1' } });
  });

  it('returns null for a missing folder rather than throwing', async () => {
    // A single-entity lookup is nullable in the schema: "not there" is a normal
    // answer to a question, not a failure. The mutations are where a missing id
    // is an error, because there the caller asked for something to happen.
    const stub = createPrismaStub({ folders: [] });

    const folder = await Query.folder({}, { id: 'nope' }, { prisma: stub.prisma });

    expect(folder).toBeNull();
  });
});

describe('Folder.bookmarks', () => {
  it("fetches a folder's bookmarks in a stable order", async () => {
    const stub = createPrismaStub({ bookmarks: [makeBookmark({ id: 'b1' })] });

    const bookmarks = await Folder.bookmarks(
      makeFolder({ id: 'f1' }),
      {},
      {
        prisma: stub.prisma,
      },
    );

    expect(bookmarks.map((b) => b.id)).toEqual(['b1']);
    expect(stub.argsOf('bookmark', 'findMany')).toEqual({
      where: { folderId: 'f1' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  });
});

describe('Mutation.createFolder', () => {
  it('trims the name and returns the created folder', async () => {
    const stub = createPrismaStub();

    const created = await Mutation.createFolder(
      {},
      { name: '  Reading  ' },
      {
        prisma: stub.prisma,
      },
    );

    expect(created.name).toBe('Reading');
    expect(stub.argsOf('folder', 'create')).toEqual({ data: { name: 'Reading' } });
  });

  it('rejects a blank name and writes nothing', async () => {
    const stub = createPrismaStub();

    let caught: unknown;
    try {
      await Mutation.createFolder({}, { name: '   ' }, { prisma: stub.prisma });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).extensions).toMatchObject({
      code: ErrorCode.BAD_USER_INPUT,
      field: 'name',
    });
    expect(stub.calls).toEqual([]);
  });

  it('rejects a name longer than the column allows', async () => {
    const stub = createPrismaStub();

    let caught: unknown;
    try {
      await Mutation.createFolder({}, { name: 'x'.repeat(256) }, { prisma: stub.prisma });
    } catch (error) {
      caught = error;
    }

    // Caught in application code rather than surfaced as a raw Postgres
    // "value too long for type character varying(255)".
    expect(caught).toBeInstanceOf(ValidationError);
    expect(stub.calls).toEqual([]);
  });
});
