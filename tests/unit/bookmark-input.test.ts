import { describe, expect, it } from 'bun:test';
import {
  buildBookmarkCreateData,
  buildBookmarkUpdateData,
} from '../../src/graphql/resolvers/bookmark.input';
import { ErrorCode, ValidationError } from '../../src/lib/errors';

/**
 * The input builders are pure, so they are asserted directly. Their job is not
 * only to reject bad input but to produce exactly the right Prisma payload —
 * both are checked here.
 */

const VALID_CREATE = { title: 'Prisma docs', url: 'https://prisma.io', folderId: 'f1' };

/** Returns the error a builder threw, so type, code, field and message can all be asserted. */
function captureValidationError(run: () => unknown): ValidationError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ValidationError);
  const error = caught as ValidationError;
  expect(error.extensions['code']).toBe(ErrorCode.BAD_USER_INPUT);
  return error;
}

describe('buildBookmarkCreateData', () => {
  it('passes valid input through with the folder id intact', () => {
    expect(buildBookmarkCreateData(VALID_CREATE)).toEqual({
      title: 'Prisma docs',
      url: 'https://prisma.io',
      folderId: 'f1',
    });
  });

  it('omits tags entirely when not supplied, leaving the column default to apply', () => {
    expect(buildBookmarkCreateData(VALID_CREATE)).not.toHaveProperty('tags');
    expect(buildBookmarkCreateData({ ...VALID_CREATE, tags: null })).not.toHaveProperty('tags');
  });

  it('treats an explicitly empty tag list as a real value', () => {
    expect(buildBookmarkCreateData({ ...VALID_CREATE, tags: [] }).tags).toEqual([]);
  });

  it('trims title, url and every tag', () => {
    expect(
      buildBookmarkCreateData({
        title: '  Prisma docs  ',
        url: '  https://prisma.io  ',
        folderId: 'f1',
        tags: ['  db  ', ' orm '],
      }),
    ).toEqual({
      title: 'Prisma docs',
      url: 'https://prisma.io',
      folderId: 'f1',
      tags: ['db', 'orm'],
    });
  });

  it('rejects a blank title', () => {
    const error = captureValidationError(() =>
      buildBookmarkCreateData({ ...VALID_CREATE, title: '   ' }),
    );
    expect(error.extensions['field']).toBe('title');
  });

  it.each(['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'ftp://a.com/x'])(
    'rejects the non-web URL %p',
    (url) => {
      const error = captureValidationError(() => buildBookmarkCreateData({ ...VALID_CREATE, url }));
      expect(error.extensions['field']).toBe('url');
    },
  );

  it('rejects a blank tag', () => {
    const error = captureValidationError(() =>
      buildBookmarkCreateData({ ...VALID_CREATE, tags: ['ok', '  '] }),
    );
    expect(error.extensions['field']).toBe('tags');
  });
});

describe('buildBookmarkUpdateData', () => {
  it('includes only the fields that were supplied', () => {
    expect(buildBookmarkUpdateData({ title: 'New' })).toEqual({ title: 'New' });
    expect(buildBookmarkUpdateData({ url: 'https://b.com' })).toEqual({ url: 'https://b.com' });
    expect(buildBookmarkUpdateData({ title: 'New', tags: ['x'] })).toEqual({
      title: 'New',
      tags: ['x'],
    });
  });

  it('trims the values it does include', () => {
    expect(buildBookmarkUpdateData({ title: '  New  ', tags: ['  x  '] })).toEqual({
      title: 'New',
      tags: ['x'],
    });
  });

  it('treats an empty tag list as a real update that clears the tags', () => {
    // [] must not be confused with "field omitted" — it is how a client removes
    // every tag from a bookmark.
    expect(buildBookmarkUpdateData({ tags: [] })).toEqual({ tags: [] });
  });

  it('rejects an update that names no fields', () => {
    const error = captureValidationError(() => buildBookmarkUpdateData({}));
    expect(error.extensions['field']).toBe('input');
    expect(error.message).toBe('Provide at least one field to update (title, url or tags).');
  });

  it('treats explicit nulls as absent, so a null-only update is rejected', () => {
    // title and url are non-null columns; null could never be stored, so the
    // only coherent reading of null is "I did not supply this".
    const error = captureValidationError(() =>
      buildBookmarkUpdateData({ title: null, url: null, tags: null }),
    );
    expect(error.extensions['field']).toBe('input');
  });

  it('ignores a null field alongside a supplied one', () => {
    expect(buildBookmarkUpdateData({ title: 'New', url: null })).toEqual({ title: 'New' });
  });

  it('validates the fields it does include', () => {
    expect(
      captureValidationError(() => buildBookmarkUpdateData({ title: '' })).extensions['field'],
    ).toBe('title');
    expect(
      captureValidationError(() => buildBookmarkUpdateData({ url: 'not a url' })).extensions[
        'field'
      ],
    ).toBe('url');
  });
});
