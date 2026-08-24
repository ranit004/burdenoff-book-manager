import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createTestApi } from '../support/integration-api';

/**
 * Pagination and filtering against real Postgres.
 *
 * This is the suite the unit tests cannot substitute for. Those assert the
 * query object the resolver builds; only Postgres can say whether that object
 * produces a correct, stable, gap-free page sequence — or whether
 * `mode: 'insensitive'` really reaches ILIKE.
 *
 * Every fixture lives in its own namespaced folder and every query filters by
 * that folder, so the counts here are exact rather than "at least".
 */

const api = createTestApi();

interface Page {
  items: { id: string; title: string }[];
  nextCursor: string | null;
}

const PAGE_QUERY = `
  query ($folderId: ID, $search: String, $take: Int, $cursor: String) {
    bookmarks(folderId: $folderId, search: $search, take: $take, cursor: $cursor) {
      items { id title }
      nextCursor
    }
  }
`;

beforeAll(async () => {
  await api.requireDatabase();
});

afterAll(async () => {
  await api.cleanup();
});

async function newFolder(suffix: string): Promise<string> {
  const folder = await api.prisma.folder.create({ data: { name: api.name(suffix) } });
  return folder.id;
}

async function page(variables: Record<string, unknown>): Promise<Page> {
  const data = await api.gql<{ bookmarks: Page }>(PAGE_QUERY, variables);
  return data.bookmarks;
}

/** Follows nextCursor to exhaustion, returning every page in order. */
async function walkAllPages(variables: Record<string, unknown>): Promise<Page[]> {
  const pages: Page[] = [];
  let cursor: string | null = null;

  do {
    const current: Page = await page({ ...variables, cursor });
    pages.push(current);
    cursor = current.nextCursor;
    // A cursor loop that never terminates is the failure mode worth guarding:
    // without this, a bug that returns the same cursor forever hangs the suite
    // instead of failing it.
    if (pages.length > 50) {
      throw new Error('Pagination did not terminate after 50 pages.');
    }
  } while (cursor !== null);

  return pages;
}

// ---------------------------------------------------------------------------
// Cursor stability
// ---------------------------------------------------------------------------

describe('cursor pagination over rows sharing a timestamp', () => {
  // The hard case for a timestamp cursor. Bulk imports and seeded data produce
  // identical createdAt values routinely.
  //
  // These tests pin the observable contract: every row appears exactly once,
  // pages neither repeat nor skip, and repeating the walk gives the same
  // sequence.
  //
  // Why the ORDER BY carries `id`, in the SQL Prisma generates for a cursor:
  //
  //   orderBy [createdAt, id] -> WHERE createdAt > X OR (createdAt = X AND id >= Y)
  //   orderBy [createdAt]     -> WHERE createdAt >= X ... OFFSET 1
  //
  // The first is a total order, so the cursor names exactly one row. The second
  // matches every tied row and then blindly drops one, leaving the result to
  // whichever order the query plan happened to produce — which SQL does not
  // specify.
  //
  // Worth knowing about the tests below: on freshly bulk-inserted rows they pass
  // with the tiebreaker removed, because Postgres returns those rows in id order
  // anyway. That is why the fixture edits a row (see beforeAll) — with physical
  // order no longer matching id order, dropping the tiebreaker does fail the
  // ordering assertion. Verified in both directions rather than assumed.
  const SAME_INSTANT = new Date('2026-01-01T00:00:00.000Z');
  let folderId: string;
  let expectedIds: string[];

  beforeAll(async () => {
    folderId = await newFolder('tie');
    await api.prisma.bookmark.createMany({
      data: [1, 2, 3, 4, 5].map((n) => ({
        title: `Tied ${String(n)}`,
        url: `https://example.com/${String(n)}`,
        folderId,
        createdAt: SAME_INSTANT,
        updatedAt: SAME_INSTANT,
      })),
    });

    const rows = await api.prisma.bookmark.findMany({
      where: { folderId },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    expectedIds = rows.map((row) => row.id);
    expect(expectedIds).toHaveLength(5);

    // Edit the lowest-id row. Postgres implements UPDATE as insert-plus-mark,
    // so its tuple moves to the end of the heap and physical order stops
    // matching id order.
    //
    // This is what stops the ordering assertions below from being satisfied by
    // coincidence. Freshly bulk-inserted rows come back in id order under any
    // ORDER BY, tiebreaker or not, so a test written against untouched rows
    // proves nothing about the sort. It also matches reality: bookmarks get
    // edited, and the edited ones are exactly where an unstable page boundary
    // would first show up.
    await api.prisma.bookmark.update({
      where: { id: expectedIds[0] },
      data: { title: 'Tied 1 (edited)' },
    });
  });

  it('returns every row exactly once across pages, with no gaps or repeats', async () => {
    const pages = await walkAllPages({ folderId, take: 2 });

    expect(pages.map((p) => p.items.length)).toEqual([2, 2, 1]);

    const seen = pages.flatMap((p) => p.items.map((item) => item.id));
    expect(new Set(seen).size).toBe(5);
    expect([...seen].sort()).toEqual([...expectedIds].sort());
  });

  it('returns the same sequence when the walk is repeated', async () => {
    // Stability, not just completeness: an unstable sort can still yield five
    // distinct rows on a lucky run.
    const first = (await walkAllPages({ folderId, take: 2 })).flatMap((p) =>
      p.items.map((i) => i.id),
    );
    const second = (await walkAllPages({ folderId, take: 2 })).flatMap((p) =>
      p.items.map((i) => i.id),
    );

    expect(second).toEqual(first);
  });

  it('orders tied rows by id, the documented tiebreaker', async () => {
    // With createdAt tied across all five rows and physical order deliberately
    // no longer matching id order, an ORDER BY that stopped being total shows up
    // here as heap order instead of id order. This is the assertion that fails
    // if the tiebreaker is dropped.
    const pages = await walkAllPages({ folderId, take: 2 });
    const seen = pages.flatMap((p) => p.items.map((item) => item.id));

    expect(seen).toEqual([...seen].sort());
  });

  it('does not emit an empty trailing page when the total is an exact multiple', async () => {
    // 5 rows at 5 per page. The over-fetch (take = pageSize + 1) finds no sixth
    // row, so nextCursor is null immediately rather than after one wasted round
    // trip returning zero items.
    const pages = await walkAllPages({ folderId, take: 5 });

    expect(pages).toHaveLength(1);
    expect(pages[0]?.items).toHaveLength(5);
    expect(pages[0]?.nextCursor).toBeNull();
  });

  it('excludes the cursor row itself', async () => {
    const first = await page({ folderId, take: 2 });
    const second = await page({ folderId, take: 2, cursor: first.nextCursor });

    const firstIds = first.items.map((i) => i.id);
    expect(second.items.map((i) => i.id).some((id) => firstIds.includes(id))).toBe(false);
    // nextCursor is the last item of the page, and skip: 1 steps past it.
    expect(first.nextCursor).toBe(firstIds[1] ?? null);
  });

  it('treats an unknown cursor as an empty page rather than an error', async () => {
    // Prisma's cursor is a WHERE-anchor, so an id that matches nothing yields
    // no rows. Documented here because "empty page" is a much better outcome
    // than a 500, and it should not regress into one.
    const result = await page({ folderId, take: 2, cursor: 'not-a-real-id' });

    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Page size
// ---------------------------------------------------------------------------

describe('page size limits', () => {
  let folderId: string;

  beforeAll(async () => {
    folderId = await newFolder('cap');
    await api.prisma.bookmark.createMany({
      data: Array.from({ length: 105 }, (_, index) => ({
        title: `Row ${String(index).padStart(3, '0')}`,
        url: `https://example.com/${String(index)}`,
        folderId,
      })),
    });
  });

  it('defaults to 20 per page', async () => {
    const result = await page({ folderId });

    expect(result.items).toHaveLength(20);
    expect(result.nextCursor).not.toBeNull();
  });

  it('caps an oversized request at 100 instead of rejecting it', async () => {
    // Clamping rather than erroring: the request is answerable, and a client
    // asking for too much gets a valid page plus a cursor to continue with.
    const result = await page({ folderId, take: 1000 });

    expect(result.items).toHaveLength(100);
    expect(result.nextCursor).not.toBeNull();
  });

  it('honours a page size below the cap', async () => {
    const result = await page({ folderId, take: 7 });
    expect(result.items).toHaveLength(7);
  });

  it('rejects take: 0 with BAD_USER_INPUT', async () => {
    const response = await api.raw(PAGE_QUERY, { folderId, take: 0 });

    expect(response.errors?.[0]?.extensions).toMatchObject({
      code: 'BAD_USER_INPUT',
      field: 'take',
    });
  });
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

describe('filtering', () => {
  let readingId: string;
  let archiveId: string;

  beforeAll(async () => {
    readingId = await newFolder('filter-reading');
    archiveId = await newFolder('filter-archive');

    await api.prisma.bookmark.createMany({
      data: [
        { title: 'Postgres Tuning', url: 'https://example.com/pg', folderId: readingId },
        { title: 'postgres internals', url: 'https://example.com/pgi', folderId: readingId },
        { title: 'Systems book', url: 'https://example.com/rust-guide', folderId: readingId },
        { title: 'Postgres Archive Copy', url: 'https://example.com/pgc', folderId: archiveId },
      ],
    });
  });

  it('restricts results to one folder', async () => {
    const result = await page({ folderId: archiveId });

    expect(result.items.map((i) => i.title)).toEqual(['Postgres Archive Copy']);
  });

  it('matches titles case-insensitively', async () => {
    // The real assertion is about Postgres, not the resolver: `mode:
    // 'insensitive'` has to become ILIKE for an uppercase term to match a
    // lowercase title.
    const result = await page({ folderId: readingId, search: 'POSTGRES' });

    expect(result.items.map((i) => i.title).sort()).toEqual([
      'Postgres Tuning',
      'postgres internals',
    ]);
  });

  it('matches a substring from the middle of a title', async () => {
    const result = await page({ folderId: readingId, search: 'gres Tun' });

    expect(result.items.map((i) => i.title)).toEqual(['Postgres Tuning']);
  });

  it('searches titles only, not urls', async () => {
    // Deliberate scope, stated in the schema: `search` is a title filter. A
    // bookmark whose URL contains the term does not match.
    const result = await page({ folderId: readingId, search: 'rust' });

    expect(result.items).toEqual([]);
  });

  it('ignores a blank search instead of matching nothing', async () => {
    const blank = await page({ folderId: readingId, search: '   ' });
    const unfiltered = await page({ folderId: readingId });

    expect(blank.items.map((i) => i.id)).toEqual(unfiltered.items.map((i) => i.id));
    expect(blank.items).toHaveLength(3);
  });

  it('combines folder, search and pagination in one query', async () => {
    const pages = await walkAllPages({ folderId: readingId, search: 'postgres', take: 1 });

    expect(pages.map((p) => p.items.length)).toEqual([1, 1]);
    const titles = pages.flatMap((p) => p.items.map((i) => i.title));
    // Scoped to the reading folder: the archive folder's matching bookmark is
    // correctly excluded, which is what proves the two filters are ANDed.
    expect(titles.sort()).toEqual(['Postgres Tuning', 'postgres internals']);
  });

  it('returns an empty page rather than an error when nothing matches', async () => {
    const result = await page({ folderId: readingId, search: 'no-such-title-anywhere' });

    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it('returns an empty page for a folder id that does not exist', async () => {
    // A filter, not a lookup: filtering on a missing folder is an empty result,
    // not NOT_FOUND. Mutations are where a missing id is an error.
    const result = await page({ folderId: 'does-not-exist' });

    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe('ordering', () => {
  it('returns bookmarks oldest first', async () => {
    const folderId = await newFolder('ordering');
    const base = Date.parse('2026-02-01T00:00:00.000Z');

    // Inserted newest-first so a missing ORDER BY would surface as insertion
    // order and fail here.
    await api.prisma.bookmark.createMany({
      data: [3, 1, 2].map((n) => ({
        title: `Day ${String(n)}`,
        url: `https://example.com/${String(n)}`,
        folderId,
        createdAt: new Date(base + n * 86_400_000),
      })),
    });

    const result = await page({ folderId });

    expect(result.items.map((i) => i.title)).toEqual(['Day 1', 'Day 2', 'Day 3']);
  });
});
