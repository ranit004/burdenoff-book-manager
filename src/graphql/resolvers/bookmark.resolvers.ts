import type { Bookmark, Folder } from '../../generated/prisma/client';
import { NotFoundError, assertValid } from '../../lib/errors';
import { validateTake } from '../../lib/validation';
import type { GraphQLContext } from '../context';
import {
  buildBookmarkPageQuery,
  resolvePageSize,
  toBookmarkConnection,
  type BookmarkPageArgs,
} from './bookmark.query';

/**
 * Bookmark queries.
 *
 * Filtering and pagination are both built by pure helpers in bookmark.query.ts,
 * so this resolver is only orchestration: validate, build, query, shape.
 */

/** One page of bookmarks. Shape matches the `BookmarkConnection` SDL type. */
export interface BookmarkConnection {
  readonly items: Bookmark[];
  readonly nextCursor: string | null;
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
