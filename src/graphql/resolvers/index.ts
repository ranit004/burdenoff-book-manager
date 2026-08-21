import { DateTimeResolver } from 'graphql-scalars';
import { folderResolvers } from './folder.resolvers';

/**
 * The single resolver map handed to makeExecutableSchema.
 *
 * Resolvers are split by domain entity into sibling modules and merged here,
 * so each module stays small and the schema does not need to know how many
 * there are. Later steps add the bookmark query and mutation resolvers.
 */
export const resolvers = {
  // Belongs to the schema itself rather than to any one operation.
  DateTime: DateTimeResolver,

  Query: {
    ...folderResolvers.Query,
  },

  Mutation: {},

  Folder: {
    ...folderResolvers.Folder,
  },
};
