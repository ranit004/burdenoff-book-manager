import { loadEnv } from './config/env';
import { prisma } from './db/client';
import { createGraphQLServer } from './graphql/yoga';

/**
 * Process entrypoint.
 *
 * Deliberately thin: it reads configuration, binds a port, and arranges for a
 * clean shutdown. All server configuration lives in src/graphql/yoga.ts so it
 * can be exercised by tests without this file running.
 */

const { PORT } = loadEnv();
const isDev = process.env['NODE_ENV'] !== 'production';

const yoga = createGraphQLServer({ prisma, isDev });

const server = Bun.serve({
  port: PORT,
  // `yoga.fetch` rather than `yoga` itself: the instance is also callable with
  // Node's (req, res) pair, and that overload is what Bun's second argument
  // would bind to. The fetch handler is the WHATWG-standard entry.
  fetch: (request) => yoga.fetch(request),
});

console.log(`GraphQL ready at http://localhost:${String(server.port)}/graphql`);
if (isDev) {
  console.log('GraphiQL is enabled (development). Set NODE_ENV=production to disable it.');
}

/**
 * Closes the pool on the way out.
 *
 * Without this, a restart under `--watch` leaks a connection per reload and
 * Postgres starts refusing new ones partway through a session. `stop(true)`
 * closes in-flight requests rather than waiting on them indefinitely.
 */
async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} received, shutting down.`);
  await server.stop(true);
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
