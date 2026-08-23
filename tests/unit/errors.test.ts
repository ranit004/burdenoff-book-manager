import { describe, expect, it } from 'bun:test';
import { GraphQLError } from 'graphql';
import { ErrorCode, NotFoundError, ValidationError, assertValid } from '../../src/lib/errors';
import { InvalidInputError } from '../../src/lib/validation';

describe('ErrorCode', () => {
  it('exposes the documented machine-readable codes', () => {
    expect(ErrorCode).toEqual({
      NOT_FOUND: 'NOT_FOUND',
      BAD_USER_INPUT: 'BAD_USER_INPUT',
    });
  });
});

describe('NotFoundError', () => {
  it('extends GraphQLError with extensions.code NOT_FOUND and the entity details', () => {
    const error = new NotFoundError('Bookmark', 'bm_123');

    expect(error).toBeInstanceOf(GraphQLError);
    expect(error.extensions.code).toBe(ErrorCode.NOT_FOUND);
    expect(error.extensions.entity).toBe('Bookmark');
    expect(error.extensions.id).toBe('bm_123');
    expect(error.message).toBe('Bookmark with id "bm_123" was not found.');
  });
});

describe('ValidationError', () => {
  it('extends GraphQLError with extensions.code BAD_USER_INPUT', () => {
    const error = new ValidationError('nope');

    expect(error).toBeInstanceOf(GraphQLError);
    expect(error.extensions.code).toBe(ErrorCode.BAD_USER_INPUT);
    expect(error.message).toBe('nope');
  });

  it('attaches the offending field when provided', () => {
    expect(new ValidationError('bad url', 'url').extensions.field).toBe('url');
  });

  it('omits the field key when absent', () => {
    expect('field' in new ValidationError('bad url').extensions).toBe(false);
  });
});

describe('assertValid', () => {
  it('does nothing when every check passes', () => {
    expect(() =>
      assertValid(
        () => undefined,
        () => undefined,
      ),
    ).not.toThrow();
  });

  it('translates InvalidInputError into ValidationError with the same message and field', () => {
    try {
      assertValid(() => {
        throw new InvalidInputError('title', 'title must not be empty.');
      });
      throw new Error('expected assertValid to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const validationError = error as ValidationError;
      expect(validationError.message).toBe('title must not be empty.');
      expect(validationError.extensions.field).toBe('title');
      expect(validationError.extensions.code).toBe(ErrorCode.BAD_USER_INPUT);
    }
  });

  it('stops at the first failing check', () => {
    let secondCheckRan = false;
    try {
      assertValid(
        () => {
          throw new InvalidInputError('title', 'bad title');
        },
        () => {
          secondCheckRan = true;
        },
      );
    } catch {
      // expected
    }
    expect(secondCheckRan).toBe(false);
  });

  it('lets non-validation errors propagate untouched', () => {
    // A bug in a validator must not be misreported to the client as bad input.
    expect(() =>
      assertValid(() => {
        throw new TypeError('validator bug');
      }),
    ).toThrow(TypeError);
  });
});
