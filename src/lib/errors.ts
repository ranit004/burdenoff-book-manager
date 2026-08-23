import { GraphQLError } from 'graphql';
import { InvalidInputError } from './validation';

/**
 * Domain error types.
 *
 * Both extend GraphQLError and set `extensions.code`, so clients can branch on
 * a stable machine-readable code instead of string-matching the message. These
 * are the errors the Yoga server explicitly allow-lists through its error
 * masking (see src/graphql/yoga.ts) — everything else is masked as a generic
 * "Unexpected error" so internals never leak.
 */

export const ErrorCode = {
  /** The requested entity does not exist. */
  NOT_FOUND: 'NOT_FOUND',
  /** The request was well-formed GraphQL but the values were unacceptable. */
  BAD_USER_INPUT: 'BAD_USER_INPUT',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Raised when a mutation targets an entity that does not exist.
 *
 * Note the asymmetry with queries: `folder(id)` is a nullable field and returns
 * `null` for a missing folder, because that is GraphQL's convention for
 * lookups. A mutation cannot meaningfully "succeed with null", so it throws.
 */
export class NotFoundError extends GraphQLError {
  constructor(entity: string, id: string) {
    super(`${entity} with id "${id}" was not found.`, {
      extensions: { code: ErrorCode.NOT_FOUND, entity, id },
    });
    this.name = 'NotFoundError';
  }
}

/** Raised when input fails a validation rule from src/lib/validation.ts. */
export class ValidationError extends GraphQLError {
  constructor(message: string, field?: string) {
    super(message, {
      extensions: {
        code: ErrorCode.BAD_USER_INPUT,
        ...(field === undefined ? {} : { field }),
      },
    });
    this.name = 'ValidationError';
  }
}

/**
 * Runs validation checks, translating the framework-agnostic
 * `InvalidInputError` into a `ValidationError` that GraphQL understands.
 *
 * This is the single seam between the two layers: validators stay free of
 * GraphQL imports, and resolvers never repeat try/catch boilerplate.
 *
 * @example
 * assertValid(
 *   () => validateTitle(input.title),
 *   () => validateUrl(input.url),
 * );
 */
export function assertValid(...checks: ReadonlyArray<() => void>): void {
  for (const check of checks) {
    try {
      check();
    } catch (error) {
      if (error instanceof InvalidInputError) {
        throw new ValidationError(error.message, error.field);
      }
      // Not a validation failure — a genuine bug. Let it propagate untouched
      // so it is not misreported to the client as bad input.
      throw error;
    }
  }
}
