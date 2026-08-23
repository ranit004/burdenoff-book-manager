import type { Prisma } from '../../generated/prisma/client';
import { ValidationError, assertValid } from '../../lib/errors';
import { validateTags, validateTitle, validateUrl } from '../../lib/validation';

/**
 * Input shaping for bookmark mutations.
 *
 * Kept out of the resolvers for the same reason as bookmark.query.ts: these are
 * pure functions from input to a Prisma payload, so every validation and
 * normalization rule can be asserted directly without a database.
 */

export interface CreateBookmarkInput {
  readonly title: string;
  readonly url: string;
  readonly folderId: string;
  readonly tags?: readonly string[] | null;
}

export interface UpdateBookmarkInput {
  readonly title?: string | null;
  readonly url?: string | null;
  readonly tags?: readonly string[] | null;
}

/**
 * Text is stored trimmed.
 *
 * Surrounding whitespace is invisible in every client that renders the value,
 * so keeping it would produce records a user cannot distinguish but which sort
 * and compare differently. Trimming normalizes something the user cannot see;
 * it never removes meaning.
 */
function trimTags(tags: readonly string[]): string[] {
  return tags.map((tag) => tag.trim());
}

/**
 * Validates and normalizes the payload for `createBookmark`.
 *
 * `tags` is omitted from the result when the client did not send it, so the
 * column default (`[]`) applies rather than this layer hardcoding it. An
 * explicitly empty list is passed through, since "no tags" is a legitimate
 * thing to state.
 */
export function buildBookmarkCreateData(
  input: CreateBookmarkInput,
): Prisma.BookmarkUncheckedCreateInput {
  const { title, url, tags } = input;

  assertValid(
    () => {
      validateTitle(title);
    },
    () => {
      validateUrl(url);
    },
    () => {
      validateTags(tags ?? []);
    },
  );

  return {
    title: title.trim(),
    url: url.trim(),
    folderId: input.folderId,
    ...(tags === undefined || tags === null ? {} : { tags: trimTags(tags) }),
  };
}

/**
 * Validates and normalizes the payload for `updateBookmark`.
 *
 * Only the fields the client actually supplied appear in the result, so an
 * omitted field is left untouched rather than overwritten with a default.
 *
 * An explicit `null` is treated as "not supplied". The alternative would be to
 * interpret it as "set this column to null", which the schema cannot honour —
 * `title` and `url` are non-null columns — so it would only ever be an error.
 * Note that `tags: []` is *not* null and is therefore a real update: it clears
 * the list.
 *
 * An update naming no fields throws instead of silently succeeding. Returning
 * the unchanged row for `updateBookmark(id, input: {})` would report success for
 * a request that did nothing, which hides a client bug rather than surfacing it.
 */
export function buildBookmarkUpdateData(input: UpdateBookmarkInput): Prisma.BookmarkUpdateInput {
  const { title, url, tags } = input;
  const data: Prisma.BookmarkUpdateInput = {};

  if (title !== undefined && title !== null) {
    assertValid(() => {
      validateTitle(title);
    });
    data.title = title.trim();
  }

  if (url !== undefined && url !== null) {
    assertValid(() => {
      validateUrl(url);
    });
    data.url = url.trim();
  }

  if (tags !== undefined && tags !== null) {
    assertValid(() => {
      validateTags(tags);
    });
    data.tags = trimTags(tags);
  }

  if (Object.keys(data).length === 0) {
    throw new ValidationError(
      'Provide at least one field to update (title, url or tags).',
      'input',
    );
  }

  return data;
}
