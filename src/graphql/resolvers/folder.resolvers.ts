import type { Bookmark, Folder } from '../../generated/prisma/client';
import { assertValid } from '../../lib/errors';
import { validateName } from '../../lib/validation';
import type { GraphQLContext } from '../context';
import { BOOKMARK_ORDER_BY } from './bookmark.query';

/**
 * Folder queries and mutations.
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

interface CreateFolderArgs {
  readonly name: string;
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

  Mutation: {
    /**
     * Creates a folder.
     *
     * `name` is validated before the write, so an empty, whitespace-only, or
     * over-long name is rejected as BAD_USER_INPUT and never reaches the
     * database. GraphQL's `String!` only guarantees a string is present — it
     * says nothing about whether that string is meaningful.
     *
     * The stored name is trimmed. Persisting `"  Work  "` verbatim would sort
     * unpredictably against `"Work"` and look identical to it in a client, so
     * the leading and trailing whitespace is dropped rather than preserved as a
     * silent difference between two otherwise identical folders.
     */
    createFolder: (
      _parent: unknown,
      args: CreateFolderArgs,
      context: GraphQLContext,
    ): Promise<Folder> => {
      assertValid(() => {
        validateName(args.name);
      });

      return context.prisma.folder.create({ data: { name: args.name.trim() } });
    },
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
     * Ordering reuses `BOOKMARK_ORDER_BY`, the same constant the paginated
     * `bookmarks` query sorts by, so a folder's bookmarks appear in the same
     * order however they are reached. Sharing the constant rather than
     * repeating `[{ createdAt }, { id }]` here means the two cannot drift: a
     * change to the sort has one place to happen.
     */
    bookmarks: (parent: Folder, _args: unknown, context: GraphQLContext): Promise<Bookmark[]> =>
      context.prisma.bookmark.findMany({
        where: { folderId: parent.id },
        orderBy: BOOKMARK_ORDER_BY,
      }),
  },
};
