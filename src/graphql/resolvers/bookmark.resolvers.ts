import type { Bookmark, Folder } from '../../generated/prisma/client';
import { NotFoundError, assertValid } from '../../lib/errors';
import { validateTake } from '../../lib/validation';
import type { GraphQLContext } from '../context';
import {
  buildBookmarkCreateData,
  buildBookmarkUpdateData,
  type CreateBookmarkInput,
  type UpdateBookmarkInput,
} from './bookmark.input';
import {
  buildBookmarkPageQuery,
  resolvePageSize,
  toBookmarkConnection,
  type BookmarkPageArgs,
} from './bookmark.query';

/**
 * Bookmark queries and mutations.
 *
 * Filtering, pagination and input shaping are all built by pure helpers in
 * bookmark.query.ts and bookmark.input.ts, so these resolvers are only
 * orchestration: validate, check existence, write.
 */

/** One page of bookmarks. Shape matches the `BookmarkConnection` SDL type. */
export interface BookmarkConnection {
  readonly items: Bookmark[];
  readonly nextCursor: string | null;
}

/**
 * Confirms a row exists before a write that depends on it.
 *
 * Both helpers select only `id`: the value is never used, so there is no reason
 * to transfer the whole row across the wire to answer a yes/no question.
 *
 * Checking up front rather than letting the write fail is what turns a database
 * constraint violation into a usable API error. Prisma would otherwise raise
 * P2025 ("record not found") for a missing bookmark or P2003 (foreign key
 * violation) for a missing folder — errors that name the constraint, not the
 * entity, and which Yoga's error masking would flatten to "Unexpected error"
 * because they are not in the allow-list. The explicit check produces NOT_FOUND
 * naming the entity and the id the client actually sent.
 *
 * The check and the write are not atomic: a folder deleted in between would
 * still fail the insert. That is intentional rather than overlooked — the
 * foreign key remains the real guarantee of referential integrity, and this
 * check exists to produce a good error for the overwhelmingly common case, not
 * to replace it. Closing the window entirely needs a serializable transaction,
 * which is a real cost to pay for a race that ends in a safe failure either way.
 */
async function assertFolderExists(context: GraphQLContext, folderId: string): Promise<void> {
  const folder = await context.prisma.folder.findUnique({
    where: { id: folderId },
    select: { id: true },
  });
  if (folder === null) {
    throw new NotFoundError('Folder', folderId);
  }
}

async function assertBookmarkExists(context: GraphQLContext, id: string): Promise<void> {
  const bookmark = await context.prisma.bookmark.findUnique({
    where: { id },
    select: { id: true },
  });
  if (bookmark === null) {
    throw new NotFoundError('Bookmark', id);
  }
}

export const bookmarkResolvers = {
  Query: {
    /**
     * Bookmarks, optionally filtered by folder and/or a case-insensitive title
     * substring, returned one cursor-paginated page at a time.
     *
     * Cursor pagination rather than offset: with `skip`/`offset`, a row
     * inserted or deleted between two page requests shifts every later row, so
     * clients silently miss rows or see them twice. A cursor anchors the next
     * page to a specific row instead, which is stable under concurrent writes.
     */
    bookmarks: async (
      _parent: unknown,
      args: BookmarkPageArgs,
      context: GraphQLContext,
    ): Promise<BookmarkConnection> => {
      const requestedTake = args.take;
      if (requestedTake !== undefined && requestedTake !== null) {
        assertValid(() => {
          validateTake(requestedTake);
        });
      }

      const pageSize = resolvePageSize(requestedTake);

      // Deliberately over-fetches by one row; toBookmarkConnection strips it.
      const rows = await context.prisma.bookmark.findMany(buildBookmarkPageQuery(args, pageSize));

      return toBookmarkConnection(rows, pageSize);
    },
  },

  Mutation: {
    /**
     * Creates a bookmark in an existing folder.
     *
     * Input is validated and normalized before the folder lookup, so malformed
     * input costs no database round trip at all.
     */
    createBookmark: async (
      _parent: unknown,
      args: { input: CreateBookmarkInput },
      context: GraphQLContext,
    ): Promise<Bookmark> => {
      const data = buildBookmarkCreateData(args.input);
      await assertFolderExists(context, data.folderId);
      return context.prisma.bookmark.create({ data });
    },

    /**
     * Partially updates a bookmark. Omitted fields are left as they are.
     *
     * `updatedAt` is maintained by Prisma's `@updatedAt`, so it is not set here.
     */
    updateBookmark: async (
      _parent: unknown,
      args: { id: string; input: UpdateBookmarkInput },
      context: GraphQLContext,
    ): Promise<Bookmark> => {
      const data = buildBookmarkUpdateData(args.input);
      await assertBookmarkExists(context, args.id);
      return context.prisma.bookmark.update({ where: { id: args.id }, data });
    },

    /**
     * Deletes a bookmark.
     *
     * Returns `true`, or throws NOT_FOUND when there was nothing to delete.
     * Deliberately never returns `false`: a boolean-returning delete that
     * answers `false` forces the client to guess whether the id was wrong, the
     * row was already gone, or the write failed. Throwing keeps the return value
     * unambiguous — if it returns at all, the bookmark is gone.
     */
    deleteBookmark: async (
      _parent: unknown,
      args: { id: string },
      context: GraphQLContext,
    ): Promise<boolean> => {
      await assertBookmarkExists(context, args.id);
      await context.prisma.bookmark.delete({ where: { id: args.id } });
      return true;
    },

    /**
     * Moves a bookmark to a different folder.
     *
     * Both existence checks are issued concurrently — they are independent, so
     * running them in sequence would pay two round trips to learn two unrelated
     * facts. The results are then inspected in a fixed order, so when both the
     * bookmark and the folder are missing the error always names the bookmark
     * first rather than varying with whichever query happened to return sooner.
     */
    moveBookmark: async (
      _parent: unknown,
      args: { id: string; folderId: string },
      context: GraphQLContext,
    ): Promise<Bookmark> => {
      const [bookmark, folder] = await Promise.all([
        context.prisma.bookmark.findUnique({ where: { id: args.id }, select: { id: true } }),
        context.prisma.folder.findUnique({ where: { id: args.folderId }, select: { id: true } }),
      ]);

      if (bookmark === null) {
        throw new NotFoundError('Bookmark', args.id);
      }
      if (folder === null) {
        throw new NotFoundError('Folder', args.folderId);
      }

      return context.prisma.bookmark.update({
        where: { id: args.id },
        data: { folderId: args.folderId },
      });
    },
  },

  Bookmark: {
    /**
     * The owning folder. Declared non-null in the schema, which the required
     * foreign key plus `onDelete: Restrict` genuinely guarantees — a bookmark
     * cannot be orphaned.
     *
     * The null branch is therefore unreachable in practice, but it is cheap and
     * it fails legibly: a NOT_FOUND error naming the folder id beats GraphQL's
     * "cannot return null for non-nullable field", which says nothing about
     * what went wrong.
     */
    folder: async (parent: Bookmark, _args: unknown, context: GraphQLContext): Promise<Folder> => {
      const folder = await context.prisma.folder.findUnique({ where: { id: parent.folderId } });
      if (folder === null) {
        throw new NotFoundError('Folder', parent.folderId);
      }
      return folder;
    },
  },
};
