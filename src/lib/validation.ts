/**
 * Input validation.
 *
 * Deliberately dependency-free: no Prisma, no GraphQL, no imports at all.
 * These are pure functions over plain values, so they can be unit-tested
 * without standing up a database or a GraphQL execution context, and reused
 * from anywhere (resolvers today, a REST handler or CLI tomorrow).
 *
 * Because this module must not know about GraphQL, failures throw the
 * framework-agnostic `InvalidInputError` below. src/lib/errors.ts translates
 * that into a GraphQL error carrying `extensions.code`.
 */

/**
 * Thrown when a value fails validation. Carries the offending field name so
 * the translation layer can surface it to clients.
 */
export class InvalidInputError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidInputError';
    this.field = field;
  }
}

/** Guards against unbounded text being written to the database. */
const MAX_TITLE_LENGTH = 500;
const MAX_NAME_LENGTH = 255;
const MAX_URL_LENGTH = 2048;
const MAX_TAG_LENGTH = 50;
const MAX_TAGS = 50;

/**
 * Only web URLs are accepted. Rejecting other schemes matters because a
 * bookmark URL is rendered as a link by clients, and `javascript:` or `data:`
 * URLs are a stored-XSS vector — the URL constructor happily parses both.
 */
const ALLOWED_URL_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

function assertNonBlank(field: string, value: string, maxLength: number): void {
  if (value.trim().length === 0) {
    throw new InvalidInputError(field, `${field} must not be empty or only whitespace.`);
  }
  if (value.length > maxLength) {
    throw new InvalidInputError(
      field,
      `${field} must be at most ${maxLength} characters (received ${value.length}).`,
    );
  }
}

/** Rejects an empty, whitespace-only, or over-long bookmark title. */
export function validateTitle(title: string): void {
  assertNonBlank('title', title, MAX_TITLE_LENGTH);
}

/** Rejects an empty, whitespace-only, or over-long folder name. */
export function validateName(name: string): void {
  assertNonBlank('name', name, MAX_NAME_LENGTH);
}

/**
 * Rejects anything the URL constructor cannot parse, plus any scheme outside
 * the http/https allowlist.
 */
export function validateUrl(url: string): void {
  assertNonBlank('url', url, MAX_URL_LENGTH);

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // The URL constructor is the parser; there is no point reimplementing it
    // with a regex that will disagree with the platform.
    throw new InvalidInputError('url', `"${url}" is not a valid URL.`);
  }

  if (!ALLOWED_URL_PROTOCOLS.has(parsed.protocol)) {
    throw new InvalidInputError(
      'url',
      `URL scheme "${parsed.protocol}" is not supported; use http or https.`,
    );
  }
}

/** Rejects blank, over-long, or too many tags. */
export function validateTags(tags: readonly string[]): void {
  if (tags.length > MAX_TAGS) {
    throw new InvalidInputError('tags', `A bookmark may have at most ${MAX_TAGS} tags.`);
  }

  for (const tag of tags) {
    if (tag.trim().length === 0) {
      throw new InvalidInputError('tags', 'Tags must not be empty or only whitespace.');
    }
    if (tag.length > MAX_TAG_LENGTH) {
      throw new InvalidInputError(
        'tags',
        `Each tag must be at most ${MAX_TAG_LENGTH} characters (received ${tag.length}).`,
      );
    }
  }
}

/**
 * Rejects a page size that cannot describe a page.
 *
 * Only the lower bound is an error. An oversized `take` is clamped to the
 * server's maximum instead (see resolvePageSize): the client still receives a
 * full page and a cursor to continue from, so clamping loses it nothing, while
 * `take: 0` or `take: -5` has no reasonable interpretation at all.
 *
 * GraphQL's Int already guarantees a 32-bit integer, but the integer check is
 * kept so the rule holds for any non-GraphQL caller of this module.
 */
export function validateTake(take: number): void {
  if (!Number.isInteger(take)) {
    throw new InvalidInputError('take', `take must be a whole number (received ${String(take)}).`);
  }
  if (take < 1) {
    throw new InvalidInputError('take', `take must be at least 1 (received ${String(take)}).`);
  }
}
