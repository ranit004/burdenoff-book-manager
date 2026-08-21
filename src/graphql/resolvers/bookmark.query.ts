import type { Prisma } from '../../generated/prisma/client';

/**
 * Query-shaping helpers for bookmarks.
 *
 * Filtering lives here, separate from the resolver, for two reasons: the
 * `where` clause becomes a pure function that can be asserted on directly in
 * tests, and Step 8's pagination can wrap it without touching filter logic.
 */

export interface BookmarkFilterArgs {
  readonly folderId?: string | null;
  readonly search?: string | null;
}

/**
 * Builds the Prisma `where` clause for the `bookmarks` query.
 *
 * Both filters are optional and combine with AND when both are supplied.
 * Omitted, null, and blank values are all treated as "no filter" — a client
 * sending `search: ""` means "everything", not "titles matching the empty
 * string", which would be a needless full scan with a no-op predicate.
 */
export function buildBookmarkWhere(args: BookmarkFilterArgs): Prisma.BookmarkWhereInput {
  const where: Prisma.BookmarkWhereInput = {};

  const folderId = args.folderId?.trim();
  if (folderId !== undefined && folderId !== '') {
    where.folderId = folderId;
  }

  const search = args.search?.trim();
  if (search !== undefined && search !== '') {
    // Case-insensitive substring match on title. `mode: 'insensitive'` maps to
    // Postgres ILIKE.
    //
    // Note: an unanchored ILIKE '%term%' cannot use the btree index on title,
    // so this is a sequential scan on large tables. Acceptable at this scale;
    // the real fix is a pg_trgm GIN index or full-text search, documented as a
    // future extension rather than guessed at now.
    where.title = { contains: search, mode: 'insensitive' };
  }

  return where;
}

/**
 * Sort order for every bookmark listing.
 *
 * `createdAt` is the meaningful key, with `id` as a tiebreaker. The tiebreaker
 * is not cosmetic: two bookmarks created in the same transaction can share a
 * `createdAt`, and without a unique final sort key their relative order is
 * undefined between queries — which would let cursor pagination skip or repeat
 * rows. Matches the composite indexes declared in prisma/schema.prisma.
 */
export const BOOKMARK_ORDER_BY: Prisma.BookmarkOrderByWithRelationInput[] = [
  { createdAt: 'asc' },
  { id: 'asc' },
];
