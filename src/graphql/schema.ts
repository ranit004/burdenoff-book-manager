import { makeExecutableSchema } from '@graphql-tools/schema';
import type { GraphQLSchema } from 'graphql';
import { resolvers } from './resolvers';

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

export const schema: GraphQLSchema = makeExecutableSchema({
  typeDefs,
  resolvers,
});
