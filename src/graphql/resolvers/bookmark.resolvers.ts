import type { Bookmark, Folder } from '../../generated/prisma/client';
import { NotFoundError } from '../../lib/errors';
import type { GraphQLContext } from '../context';
import { BOOKMARK_ORDER_BY, buildBookmarkWhere, type BookmarkFilterArgs } from './bookmark.query';

/**
 * Bookmark queries.
 *
 * Filtering only at this step — `take`/`cursor` are declared in the schema but
 * not yet honoured; pagination wraps this query in the next step. The `where`
 * clause is built by a pure helper so that layering stays additive.
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
     * substring. Returns every match for now, so `nextCursor` is always null.
     */
    bookmarks: async (
      _parent: unknown,
      args: BookmarkFilterArgs,
      context: GraphQLContext,
    ): Promise<BookmarkConnection> => {
      const items = await context.prisma.bookmark.findMany({
        where: buildBookmarkWhere(args),
        orderBy: BOOKMARK_ORDER_BY,
      });

      return { items, nextCursor: null };
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
