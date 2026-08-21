import { makeExecutableSchema } from '@graphql-tools/schema';
import { DateTimeResolver } from 'graphql-scalars';
import type { GraphQLSchema } from 'graphql';

/**
 * Schema-first assembly.
 *
 * The SDL in schema.graphql is the source of truth for the API contract; this
 * module only binds implementations to it. Keeping the two separate means the
 * contract can be reviewed — and diffed — without reading resolver code.
 */

// Read the SDL at startup rather than embedding it in a template literal, so
// schema.graphql stays a real .graphql file that editors and linters can parse.
const typeDefs = await Bun.file(new URL('./schema.graphql', import.meta.url)).text();

/**
 * Resolver map. Query/Mutation/field resolvers are added in the steps that
 * implement them; `DateTime` is wired up here because it belongs to the schema
 * itself rather than to any one operation.
 *
 * DateTimeResolver serializes `Date` to an ISO-8601 string and rejects invalid
 * inputs, so the scalar is validated in both directions instead of being an
 * unchecked passthrough.
 */
export const resolvers = {
  DateTime: DateTimeResolver,
  Query: {},
  Mutation: {},
};

export const schema: GraphQLSchema = makeExecutableSchema({
  typeDefs,
  resolvers,
});
