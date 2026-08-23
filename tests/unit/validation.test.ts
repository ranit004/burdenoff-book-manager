import { describe, expect, it } from 'bun:test';
import {
  InvalidInputError,
  validateName,
  validateTags,
  validateTitle,
  validateUrl,
} from '../../src/lib/validation';

/**
 * These run with no database and no GraphQL context — the point of keeping
 * src/lib/validation.ts dependency-free.
 *
 * Every failure case asserts the thrown error's type, `field` and message, not
 * merely that something was thrown: a test that only checks "it threw" would
 * still pass if the code threw a TypeError from a typo.
 */

/** Returns the thrown error, or fails loudly if the call unexpectedly succeeds. */
function captureError(fn: () => void): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the validator to throw, but it returned normally.');
}

function expectInvalidInput(fn: () => void, field: string): InvalidInputError {
  const error = captureError(fn);
  expect(error).toBeInstanceOf(InvalidInputError);
  const invalid = error as InvalidInputError;
  expect(invalid.field).toBe(field);
  expect(invalid.message.length).toBeGreaterThan(0);
  return invalid;
}

describe('validateTitle', () => {
  it('accepts a normal title', () => {
    expect(validateTitle('Prisma docs')).toBeUndefined();
  });

  it('accepts a title with surrounding whitespace and real content', () => {
    expect(validateTitle('  Prisma docs  ')).toBeUndefined();
  });

  it('rejects an empty title', () => {
    const error = expectInvalidInput(() => validateTitle(''), 'title');
    expect(error.message).toBe('title must not be empty or only whitespace.');
  });

  it.each(['   ', '\t', '\n', ' \t\n '])('rejects the whitespace-only title %j', (title) => {
    expectInvalidInput(() => validateTitle(title), 'title');
  });

  it('rejects a title longer than 500 characters and reports the length', () => {
    const error = expectInvalidInput(() => validateTitle('a'.repeat(501)), 'title');
    expect(error.message).toBe('title must be at most 500 characters (received 501).');
  });

  it('accepts a title of exactly the maximum length', () => {
    expect(validateTitle('a'.repeat(500))).toBeUndefined();
  });
});

describe('validateName', () => {
  it('accepts a normal folder name', () => {
    expect(validateName('Reading list')).toBeUndefined();
  });

  it('rejects a whitespace-only name', () => {
    const error = expectInvalidInput(() => validateName('   '), 'name');
    expect(error.message).toBe('name must not be empty or only whitespace.');
  });

  it('rejects a name longer than 255 characters', () => {
    const error = expectInvalidInput(() => validateName('a'.repeat(256)), 'name');
    expect(error.message).toBe('name must be at most 255 characters (received 256).');
  });
});

describe('validateUrl', () => {
  it.each([
    'https://example.com',
    'http://example.com',
    'https://example.com/path?query=1#hash',
    'https://sub.example.co.uk:8443/deep/path',
    'http://localhost:3000',
  ])('accepts %s', (url) => {
    expect(validateUrl(url)).toBeUndefined();
  });

  it('rejects an empty url', () => {
    expectInvalidInput(() => validateUrl(''), 'url');
  });

  it.each(['not a url', 'example.com', '://missing-scheme', 'http://'])(
    'rejects the malformed url %j',
    (url) => {
      const error = expectInvalidInput(() => validateUrl(url), 'url');
      expect(error.message).toBe(`"${url}" is not a valid URL.`);
    },
  );

  it('accepts a single-slash authority, which WHATWG normalizes rather than rejects', () => {
    // Documents real platform behaviour: new URL('http:/example.com') parses to
    // http://example.com/. We delegate to the platform parser deliberately, so
    // the validator inherits this leniency instead of fighting it with a regex.
    expect(validateUrl('http:/example.com')).toBeUndefined();
    expect(new URL('http:/example.com').href).toBe('http://example.com/');
  });

  it('rejects a javascript: URL, which the URL constructor parses happily', () => {
    // Guards against stored XSS: clients render this value as a link target.
    const error = expectInvalidInput(() => validateUrl('javascript:alert(1)'), 'url');
    expect(error.message).toBe('URL scheme "javascript:" is not supported; use http or https.');
  });

  it.each(['data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'ftp://example.com'])(
    'rejects the non-web scheme in %j',
    (url) => {
      const error = expectInvalidInput(() => validateUrl(url), 'url');
      expect(error.message).toContain('is not supported; use http or https.');
    },
  );

  it('rejects a url longer than 2048 characters', () => {
    const error = expectInvalidInput(
      () => validateUrl(`https://example.com/${'a'.repeat(2048)}`),
      'url',
    );
    expect(error.message).toContain('must be at most 2048 characters');
  });
});

describe('validateTags', () => {
  it('accepts an empty tag list', () => {
    expect(validateTags([])).toBeUndefined();
  });

  it('accepts normal tags', () => {
    expect(validateTags(['docs', 'typescript'])).toBeUndefined();
  });

  it('rejects a blank tag', () => {
    const error = expectInvalidInput(() => validateTags(['docs', '  ']), 'tags');
    expect(error.message).toBe('Tags must not be empty or only whitespace.');
  });

  it('rejects a tag longer than 50 characters', () => {
    const error = expectInvalidInput(() => validateTags(['a'.repeat(51)]), 'tags');
    expect(error.message).toBe('Each tag must be at most 50 characters (received 51).');
  });

  it('rejects more than 50 tags', () => {
    const tags = Array.from({ length: 51 }, (_, i) => `tag-${String(i)}`);
    const error = expectInvalidInput(() => validateTags(tags), 'tags');
    expect(error.message).toBe('A bookmark may have at most 50 tags.');
  });
});
