import type { Bookmark, Folder } from '../../generated/prisma/client';
import type { GraphQLContext } from '../context';

/**
 * Folder queries.
 *
 * `folder(id)` returns `null` for a missing folder rather than throwing.
 *
 * That is a deliberate, documented choice (see README): the schema declares the
 * field as nullable `Folder`, and GraphQL convention is that a nullable lookup
 * answers "no such thing" with `null`. Throwing is reserved for mutations,
 * which cannot meaningfully succeed with null when the entity they must act on
 * is absent. Keeping the two consistent means a client can treat any
 * NOT_FOUND error as "your write did not happen", never as "nothing matched".
 */

interface FolderArgs {
  readonly id: string;
}

export const folderResolvers = {
  Query: {
    /** All folders, alphabetically. Backed by the `name` index. */
    folders: (_parent: unknown, _args: unknown, context: GraphQLContext): Promise<Folder[]> =>
      context.prisma.folder.findMany({ orderBy: { name: 'asc' } }),

    /** A single folder, or null when no folder has that id. */
    folder: (_parent: unknown, args: FolderArgs, context: GraphQLContext): Promise<Folder | null> =>
      context.prisma.folder.findUnique({ where: { id: args.id } }),
  },

  Folder: {
    /**
     * Resolved as a field rather than a join, so `{ folders { name } }` costs
     * one query instead of dragging every bookmark along with it.
     *
     * The tradeoff is the classic N+1: `{ folders { bookmarks } }` issues one
     * query per folder. Acceptable at this scale and with this folder count;
     * the fix is DataLoader batching, noted as a future extension in the README
     * rather than built speculatively here.
     *
     * Ordering matches the paginated `bookmarks` query — `createdAt` with `id`
     * as tiebreaker — so a folder's bookmarks appear in the same order however
     * they are reached.
     */
    bookmarks: (parent: Folder, _args: unknown, context: GraphQLContext): Promise<Bookmark[]> =>
      context.prisma.bookmark.findMany({
        where: { folderId: parent.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
  },
};
