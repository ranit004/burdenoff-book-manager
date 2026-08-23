// Prisma 7 configuration.
//
// In v7 the datasource URL is supplied here rather than in schema.prisma, and
// environment variables are no longer loaded automatically — hence the
// explicit `dotenv/config` import. Bun loads .env on its own, but the Prisma
// CLI runs under Node, so it needs dotenv.
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // `env()` fails with a clear message when DATABASE_URL is unset, instead
    // of passing `undefined` through to the connection attempt.
    url: env('DATABASE_URL'),
  },
});
