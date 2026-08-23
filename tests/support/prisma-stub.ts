import type { Bookmark, Folder, PrismaClient } from '../../src/generated/prisma/client';

/**
 * A recording Prisma stub, injected through the same GraphQL context the server
 * uses. No module mocking and no monkey-patching: the resolvers accept a client,
 * so a test can simply hand them a different one.
 *
 * The stub records every call, which lets a test assert two separate things:
 *
 *   1. the exact query the resolver built, and
 *   2. that a rejected request issued no write at all.
 *
 * The second is the point. "It threw the right error" says nothing about whether
 * a row was written first, and that is precisely the bug worth catching.
 *
 * These tests do not check that Prisma itself paginates or filters correctly —
 * a stub cannot answer that, and pretending otherwise would be testing the
 * stub. That is what the integration tests against real Postgres are for.
 */

export interface RecordedCall {
  readonly model: 'folder' | 'bookmark';
  readonly method: string;
  readonly args: unknown;
}

const WRITE_METHODS = new Set(['create', 'update', 'delete', 'upsert', 'createMany', 'deleteMany']);

export function makeFolder(overrides: Partial<Folder> = {}): Folder {
  return {
    id: 'f1',
    name: 'Reading',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

export function makeBookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    id: 'b1',
    title: 'Prisma docs',
    url: 'https://prisma.io',
    tags: ['db'],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    folderId: 'f1',
    ...overrides,
  };
}

export interface StubBehaviour {
  /** Rows returned by `folder.findMany`. Also defines which folder ids exist. */
  readonly folders?: readonly Folder[];
  /** Rows returned by `bookmark.findMany`. Also defines which bookmark ids exist. */
  readonly bookmarks?: readonly Bookmark[];
  /** Overrides which ids `findUnique` resolves, independently of the rows above. */
  readonly existingFolderIds?: readonly string[];
  readonly existingBookmarkIds?: readonly string[];
}

export interface PrismaStub {
  readonly prisma: PrismaClient;
  /** Every call, in order. */
  readonly calls: RecordedCall[];
  /** Only the calls that would have modified data. */
  writes: () => RecordedCall[];
  /** Args of the nth call to `model.method`, for asserting the built query. */
  argsOf: (model: 'folder' | 'bookmark', method: string, nth?: number) => unknown;
}

interface WhereId {
  where?: { id?: string };
}

interface WithData {
  data?: Record<string, unknown>;
}

export function createPrismaStub(behaviour: StubBehaviour = {}): PrismaStub {
  const calls: RecordedCall[] = [];
  const folders = behaviour.folders ?? [];
  const bookmarks = behaviour.bookmarks ?? [];

  const folderIds = new Set(behaviour.existingFolderIds ?? folders.map((f) => f.id));
  const bookmarkIds = new Set(behaviour.existingBookmarkIds ?? bookmarks.map((b) => b.id));

  function record(model: 'folder' | 'bookmark', method: string, args: unknown): void {
    calls.push({ model, method, args });
  }

  const stub = {
    folder: {
      findMany: (args: unknown) => {
        record('folder', 'findMany', args);
        return Promise.resolve([...folders]);
      },
      findUnique: (args: unknown) => {
        record('folder', 'findUnique', args);
        const id = (args as WhereId).where?.id ?? '';
        const match = folders.find((f) => f.id === id);
        if (match !== undefined) {
          return Promise.resolve(match);
        }
        return Promise.resolve(folderIds.has(id) ? makeFolder({ id }) : null);
      },
      create: (args: unknown) => {
        record('folder', 'create', args);
        const data = (args as WithData).data ?? {};
        return Promise.resolve(makeFolder({ name: data['name'] as string }));
      },
    },

    bookmark: {
      findMany: (args: unknown) => {
        record('bookmark', 'findMany', args);
        return Promise.resolve([...bookmarks]);
      },
      findUnique: (args: unknown) => {
        record('bookmark', 'findUnique', args);
        const id = (args as WhereId).where?.id ?? '';
        const match = bookmarks.find((b) => b.id === id);
        if (match !== undefined) {
          return Promise.resolve(match);
        }
        return Promise.resolve(bookmarkIds.has(id) ? makeBookmark({ id }) : null);
      },
      create: (args: unknown) => {
        record('bookmark', 'create', args);
        return Promise.resolve(makeBookmark((args as WithData).data as Partial<Bookmark>));
      },
      update: (args: unknown) => {
        record('bookmark', 'update', args);
        const id = (args as WhereId).where?.id ?? 'b1';
        return Promise.resolve(
          makeBookmark({ id, ...((args as WithData).data as Partial<Bookmark>) }),
        );
      },
      delete: (args: unknown) => {
        record('bookmark', 'delete', args);
        return Promise.resolve(makeBookmark({ id: (args as WhereId).where?.id ?? 'b1' }));
      },
    },
  };

  return {
    prisma: stub as unknown as PrismaClient,
    calls,
    writes: () => calls.filter((call) => WRITE_METHODS.has(call.method)),
    argsOf: (model, method, nth = 0) =>
      calls.filter((c) => c.model === model && c.method === method)[nth]?.args,
  };
}
