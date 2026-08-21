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

// ---------------------------------------------------------------------------
// Cursor pagination
// ---------------------------------------------------------------------------

/** Page size when the client does not ask for one. */
export const DEFAULT_TAKE = 20;

/**
 * Hard ceiling on page size. Without a cap, `bookmarks(take: 1000000)` is an
 * unbounded query any client can issue — a denial-of-service foothold and an
 * easy way to exhaust server memory.
 */
export const MAX_TAKE = 100;

export interface BookmarkPageArgs extends BookmarkFilterArgs {
  readonly take?: number | null;
  readonly cursor?: string | null;
}

/**
 * Resolves the requested page size, clamping to MAX_TAKE.
 *
 * Clamping rather than erroring on an oversized `take` is deliberate: the
 * client still gets a full page plus a `nextCursor`, so it can keep paging and
 * reach every row. Values below 1 are rejected upstream by `validateTake`,
 * because there is no sensible page to return for them.
 */
export function resolvePageSize(take?: number | null): number {
  if (take === undefined || take === null) {
    return DEFAULT_TAKE;
  }
  return Math.min(take, MAX_TAKE);
}

/** The Prisma `findMany` arguments for one page. */
export interface BookmarkPageQuery {
  readonly where: Prisma.BookmarkWhereInput;
  readonly orderBy: Prisma.BookmarkOrderByWithRelationInput[];
  readonly take: number;
  readonly cursor?: { id: string };
  readonly skip?: number;
}

/**
 * Builds the query for one page, wrapping the filter helper above.
 *
 * Two details carry the design:
 *
 * 1. `take` is pageSize + 1. Reading one row beyond the page is how we learn
 *    whether a next page exists without a second `count()` query — one round
 *    trip instead of two, and no risk of the count disagreeing with the page
 *    because rows changed in between.
 *
 * 2. Prisma treats `cursor` as inclusive, so `skip: 1` steps past the row the
 *    client already has. Without it every page would repeat its predecessor's
 *    last row.
 */
export function buildBookmarkPageQuery(
  args: BookmarkPageArgs,
  pageSize: number,
): BookmarkPageQuery {
  const cursor = args.cursor?.trim();
  const hasCursor = cursor !== undefined && cursor !== '';

  return {
    where: buildBookmarkWhere(args),
    orderBy: BOOKMARK_ORDER_BY,
    take: pageSize + 1,
    ...(hasCursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  };
}

/**
 * Splits the over-fetched rows into a page and the cursor for the next one.
 *
 * A non-null `nextCursor` therefore always has at least one row behind it: it
 * is only set when row pageSize + 1 actually came back. Clients never get a
 * cursor that leads to an empty page.
 */
export function toBookmarkConnection<T extends { id: string }>(
  rows: readonly T[],
  pageSize: number,
): { items: T[]; nextCursor: string | null } {
  const hasNextPage = rows.length > pageSize;
  const items = hasNextPage ? rows.slice(0, pageSize) : [...rows];

  return {
    items,
    nextCursor: hasNextPage ? (items.at(-1)?.id ?? null) : null,
  };
}
