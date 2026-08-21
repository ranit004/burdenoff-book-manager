import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_TAKE,
  MAX_TAKE,
  buildBookmarkPageQuery,
  resolvePageSize,
  toBookmarkConnection,
} from '../../src/graphql/resolvers/bookmark.query';
import { InvalidInputError, validateTake } from '../../src/lib/validation';

/**
 * The pagination primitives are pure functions over plain values, so they are
 * tested directly — no database, no GraphQL, no stubs.
 */

describe('resolvePageSize', () => {
  it('defaults to DEFAULT_TAKE when take is omitted or null', () => {
    expect(resolvePageSize()).toBe(DEFAULT_TAKE);
    expect(resolvePageSize(null)).toBe(DEFAULT_TAKE);
    expect(DEFAULT_TAKE).toBe(20);
  });

  it('passes through a take below the cap', () => {
    expect(resolvePageSize(1)).toBe(1);
    expect(resolvePageSize(50)).toBe(50);
    expect(resolvePageSize(MAX_TAKE)).toBe(MAX_TAKE);
  });

  it('clamps an oversized take to MAX_TAKE rather than erroring', () => {
    // Clamping keeps the query bounded while still letting the client page on.
    expect(resolvePageSize(101)).toBe(MAX_TAKE);
    expect(resolvePageSize(1_000_000)).toBe(MAX_TAKE);
    expect(MAX_TAKE).toBe(100);
  });
});

describe('validateTake', () => {
  it('accepts positive integers', () => {
    expect(validateTake(1)).toBeUndefined();
    expect(validateTake(9_999)).toBeUndefined();
  });

  it.each([0, -1, -100])('rejects %i as below the minimum', (take) => {
    let error: unknown;
    try {
      validateTake(take);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InvalidInputError);
    expect((error as InvalidInputError).field).toBe('take');
    expect((error as InvalidInputError).message).toBe(
      `take must be at least 1 (received ${String(take)}).`,
    );
  });

  it.each([1.5, Number.NaN])('rejects the non-integer %p', (take) => {
    let error: unknown;
    try {
      validateTake(take);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InvalidInputError);
    expect((error as InvalidInputError).message).toContain('must be a whole number');
  });
});

describe('buildBookmarkPageQuery', () => {
  it('over-fetches exactly one row so the next page can be detected without a count query', () => {
    expect(buildBookmarkPageQuery({}, 20).take).toBe(21);
    expect(buildBookmarkPageQuery({}, 1).take).toBe(2);
  });

  it('omits cursor and skip on the first page', () => {
    const query = buildBookmarkPageQuery({}, 20);
    expect(query.cursor).toBeUndefined();
    expect(query.skip).toBeUndefined();
  });

  it('sets skip: 1 alongside the cursor, because Prisma treats the cursor as inclusive', () => {
    const query = buildBookmarkPageQuery({ cursor: 'b7' }, 20);
    expect(query.cursor).toEqual({ id: 'b7' });
    expect(query.skip).toBe(1);
  });

  it('treats a blank cursor as no cursor', () => {
    const query = buildBookmarkPageQuery({ cursor: '   ' }, 20);
    expect(query.cursor).toBeUndefined();
    expect(query.skip).toBeUndefined();
  });

  it('carries the filters through and always sorts by [createdAt, id]', () => {
    const query = buildBookmarkPageQuery({ folderId: 'f1', search: 'prisma' }, 5);
    expect(query.where).toEqual({
      folderId: 'f1',
      title: { contains: 'prisma', mode: 'insensitive' },
    });
    expect(query.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
  });
});

describe('toBookmarkConnection', () => {
  const rows = (n: number): { id: string }[] =>
    Array.from({ length: n }, (_, i) => ({ id: `b${String(i + 1)}` }));

  it('strips the over-fetched row and returns the last kept id as nextCursor', () => {
    // 3 rows came back for a page size of 2 => a third page-worth exists.
    const page = toBookmarkConnection(rows(3), 2);
    expect(page.items.map((i) => i.id)).toEqual(['b1', 'b2']);
    expect(page.nextCursor).toBe('b2');
  });

  it('returns nextCursor null on the last page, even when it is exactly full', () => {
    // Exactly pageSize rows means the over-fetch found nothing beyond them, so
    // there is no next page and no empty trailing page is ever emitted.
    const page = toBookmarkConnection(rows(2), 2);
    expect(page.items.map((i) => i.id)).toEqual(['b1', 'b2']);
    expect(page.nextCursor).toBeNull();
  });

  it('returns nextCursor null for a partial page', () => {
    const page = toBookmarkConnection(rows(1), 2);
    expect(page.items.map((i) => i.id)).toEqual(['b1']);
    expect(page.nextCursor).toBeNull();
  });

  it('handles an empty result set', () => {
    expect(toBookmarkConnection([], 20)).toEqual({ items: [], nextCursor: null });
  });

  it('does not mutate the input rows', () => {
    const input = rows(3);
    toBookmarkConnection(input, 2);
    expect(input).toHaveLength(3);
  });
});
