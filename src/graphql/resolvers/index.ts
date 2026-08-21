import { DateTimeResolver } from 'graphql-scalars';
import { bookmarkResolvers } from './bookmark.resolvers';
import { folderResolvers } from './folder.resolvers';

/**
 * The single resolver map handed to makeExecutableSchema.
 *
 * Resolvers are split by domain entity into sibling modules and merged here,
 * so each module stays small and the schema does not need to know how many
 * there are. Later steps add the bookmark mutation resolvers.
 */
export const resolvers = {
  // Belongs to the schema itself rather than to any one operation.
  DateTime: DateTimeResolver,

  Query: {
    ...folderResolvers.Query,
    ...bookmarkResolvers.Query,
  },

  Mutation: {
    ...folderResolvers.Mutation,
  },

  Folder: {
    ...folderResolvers.Folder,
  },

  Bookmark: {
    ...bookmarkResolvers.Bookmark,
  },
};
