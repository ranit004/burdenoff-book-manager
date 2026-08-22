# Bookmark Manager API

A GraphQL API for saving bookmarks into folders, built with Bun, GraphQL Yoga,
Prisma and PostgreSQL.

- **Schema-first** — [`src/graphql/schema.graphql`](src/graphql/schema.graphql) is
  the contract; resolvers are wired to it rather than generated from code.
- **Cursor-paginated** — the `bookmarks` query pages over a stable
  `(createdAt, id)` cursor, backed by matching composite indexes.
- **Errors are deliberate** — domain failures carry a machine-readable
  `extensions.code`; everything else is masked so an internal failure cannot
  leak a connection string.
- **142 tests** — pure-function unit tests, resolver tests over an injected
  Prisma stub, and integration tests against real Postgres.

---

## Setup

Prerequisites: [Bun](https://bun.sh) ≥ 1.1 (developed on 1.4.0) and Docker.

```bash
cp .env.example .env
docker compose up -d --wait
bun install
bun run gendb
bun run dev
```

GraphiQL is then served at <http://localhost:4000/graphql>.

`bun run gendb` applies the migrations and generates the Prisma client — one
command for "get my database ready". `--wait` blocks until the container's
healthcheck passes, so that step cannot race Postgres startup.

---

## Environment variables

Copy `.env.example` to `.env`. Bun loads `.env` automatically.

| Variable            | Default            | Purpose                                                    |
| ------------------- | ------------------ | ---------------------------------------------------------- |
| `DATABASE_URL`      | _(required)_       | Postgres connection string used by Prisma.                 |
| `PORT`              | `4000`             | Port the GraphQL server listens on.                        |
| `POSTGRES_USER`     | `postgres`         | Read by `docker-compose.yml` when provisioning the volume. |
| `POSTGRES_PASSWORD` | `postgres`         | Likewise.                                                  |
| `POSTGRES_DB`       | `bookmark_manager` | Likewise.                                                  |
| `POSTGRES_PORT`     | `5432`             | Host port mapped to the container.                         |
| `NODE_ENV`          | unset (dev)        | Set to `production` to disable GraphiQL.                   |

The `POSTGRES_*` values and the credentials inside `DATABASE_URL` must agree —
Compose provisions the database from the former, Prisma connects with the latter.

Startup fails immediately with a named variable if `DATABASE_URL` is missing,
rather than surfacing a driver error on the first query.

---

## Database

| Command                     | What it does                                           |
| --------------------------- | ------------------------------------------------------ |
| `bun run gendb`             | Applies migrations and regenerates the client.         |
| `bun run db:migrate`        | Creates/applies a migration in development.            |
| `bun run db:migrate:deploy` | Applies existing migrations (CI, production).          |
| `bun run db:generate`       | Regenerates the Prisma client.                         |
| `bun run db:reset`          | Drops and recreates the schema. **Destroys all data.** |
| `bun run db:studio`         | Opens Prisma Studio.                                   |

The generated client is gitignored, so a fresh clone needs `db:generate` (it runs
as part of `db:migrate`).

### Schema

Two tables. A bookmark belongs to exactly one folder.

```
Folder                      Bookmark
------                      --------
id        cuid, pk          id        cuid, pk
name      text              title     text
createdAt timestamptz       url       text
updatedAt timestamptz       tags      text[]  default {}
                            createdAt timestamptz
                            updatedAt timestamptz
                            folderId  fk -> Folder.id  ON DELETE RESTRICT
```

`ON DELETE RESTRICT` rather than `CASCADE`: silently destroying a folder's
contents is the kind of data loss a user cannot undo, so the database refuses
and a future `deleteFolder` mutation has to decide explicitly what to do with
the bookmarks.

**Indexes** mirror the queries actually issued:

| Index                               | Serves                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| `Folder(name)`                      | `folders` — `ORDER BY name`                                                       |
| `Bookmark(folderId, createdAt, id)` | filtered pagination; also covers plain `folderId` lookups via the leftmost prefix |
| `Bookmark(createdAt, id)`           | unfiltered pagination                                                             |
| `Bookmark(title)`                   | nothing today — see note                                                          |

Each pagination index ends in `id` because the sort does — see below.

`Bookmark(title)` is honest bookkeeping: it is currently unused. It cannot
accelerate the `search` filter (an unanchored `ILIKE '%term%'` is not a btree
range), and no query orders by title yet. It is kept because title ordering is
the next sort a bookmark manager grows, but it earns its keep only then.

---

## Running the service in Docker

`docker-compose.yml` provides Postgres; the [`Dockerfile`](Dockerfile) packages
the API itself. It is a four-stage build — dependency install, `prisma generate`,
a second install without devDependencies, then a runtime stage that copies only
what the server needs and drops to the non-root `bun` user.

```bash
docker build -t bookmark-api .
docker run --rm -p 4000:4000 --network bookmark-manager_default \
  -e DATABASE_URL="postgresql://postgres:postgres@postgres:5432/bookmark_manager?schema=public" \
  bookmark-api
```

The network flag joins the Compose network so `postgres` resolves; point
`DATABASE_URL` anywhere else and the flag is unnecessary. `NODE_ENV=production`
is baked in, so GraphiQL is off — an HTML request gets `406`, not a playground.

Migrations deliberately do **not** run on container start. Applying schema
changes is a deploy step; having every replica race to do it on boot is how one
bad rollout takes the schema with it. Run `bun run db:migrate:deploy` (or a
one-shot job) against the target database first.

---

## Running tests

```bash
bun test                  # everything (needs Postgres running)
bun run test:unit         # no database required
bun run test:integration  # needs Postgres + migrations applied
bun run sanity            # typecheck + lint + format:check + all tests
```

`bun run sanity` is what CI runs — see
[`.github/workflows/ci.yml`](.github/workflows/ci.yml), which executes it against
a fresh Postgres 16 service container on every push and pull request. That also
verifies the setup steps above are sufficient on a machine that has never seen
this repository, which local green output cannot.

Three layers, each testing something the others cannot:

- **`tests/unit/`** — pure functions (validation, query shaping, connection
  assembly) and resolvers driven over an injected Prisma stub. The stub records
  every call, so these assert both the query built and that a rejected mutation
  issued **no write at all**. "It threw the right error" says nothing about
  whether a row was written first.
- **`tests/unit/error-masking.test.ts`** — drives the real Yoga server over
  `fetch` to pin both directions of masking: domain and protocol errors reach the
  client intact, everything else is replaced.
- **`tests/integration/`** — the real server against real Postgres. This is where
  `mode: 'insensitive'` is confirmed to reach ILIKE, `@default([])` to yield an
  empty array, and the foreign key to be enforced by the database rather than
  merely pre-checked by a resolver.

Integration tests never assume a pristine database: every fixture is namespaced
with a per-run id, every assertion is scoped to that namespace, and cleanup
deletes only what the run created. Truncating between tests would be less code
and would wipe whatever you had in your dev database.

---

## API

Full SDL with per-field documentation lives in
[`src/graphql/schema.graphql`](src/graphql/schema.graphql).

### Queries

```graphql
# All folders, alphabetically.
{
  folders {
    id
    name
  }
}

# One folder with its bookmarks (resolved on demand — omit the field and no
# second query is issued).
{
  folder(id: "clx…") {
    name
    bookmarks {
      id
      title
      tags
    }
  }
}

# Bookmarks, with optional filtering and pagination.
{
  bookmarks(folderId: "clx…", search: "postgres", take: 20, cursor: null) {
    items {
      id
      title
      url
    }
    nextCursor
  }
}
```

`search` is a case-insensitive substring match on `title` only. `folderId` is an
exact match. Both are optional and combine with AND; a blank or whitespace-only
value is treated as absent rather than as "match nothing".

### Mutations

```graphql
createFolder(name: "Reading"): Folder!
createBookmark(input: { title: "…", url: "https://…", folderId: "clx…", tags: ["db"] }): Bookmark!
updateBookmark(id: "clx…", input: { title: "…" }): Bookmark!   # partial
deleteBookmark(id: "clx…"): Boolean!
moveBookmark(id: "clx…", folderId: "clx…"): Bookmark!
```

Notes on behaviour that is easy to get subtly wrong:

- `updateBookmark` is a genuine partial update. Omitted fields are untouched;
  `tags: []` **clears** the list (an explicit empty list is a real value, not an
  omission); passing no fields at all is a validation error rather than a silent
  no-op.
- `deleteBookmark` returns `true` or fails with `NOT_FOUND`. It never returns
  `false`, so the boolean is never ambiguous.
- `createBookmark` and `moveBookmark` verify the target folder exists and fail
  with `NOT_FOUND`, instead of surfacing a raw constraint violation. The foreign
  key remains the actual guarantee — the check exists for the error message.

### Errors

Every client-facing error carries a stable `extensions.code`:

| Code             | Meaning                                                |
| ---------------- | ------------------------------------------------------ |
| `NOT_FOUND`      | Entity does not exist. Also carries `entity` and `id`. |
| `BAD_USER_INPUT` | Validation failure. Carries the offending `field`.     |

GraphQL's own `GRAPHQL_PARSE_FAILED` / `GRAPHQL_VALIDATION_FAILED` pass through
untouched. Anything else becomes `Unexpected error.` with
`INTERNAL_SERVER_ERROR`.

That masking is an explicit allow-list, not a reliance on the default. Yoga's
default passes through any `GraphQLError` whose `originalError` chain bottoms
out — which would carry our own errors correctly, but equally carry one raised
inside a dependency, and those are exactly the errors most likely to quote a
connection string. This was a real bug during development, caught by a test that
plants a fake credential in a dependency error and asserts it never appears in
the response body.

**Validation limits:** title ≤ 500 chars, folder name ≤ 255, URL ≤ 2048, ≤ 50
tags of ≤ 50 chars each. URLs must parse and use `http:` or `https:` —
`javascript:` and `data:` are rejected, since a stored `javascript:` URL is a
stored-XSS payload for any client that renders it as a link.

---

## Pagination approach

Cursor-based, not offset-based.

**Why.** `OFFSET n` re-scans and discards `n` rows on every page, so cost grows
with depth, and any insert or delete before the offset shifts every later page —
a client paging through gets duplicates and gaps. A cursor names a position in a
total order instead, so it is stable under concurrent writes and costs the same
at page 1000 as at page 1.

**How.** The sort is `ORDER BY createdAt ASC, id ASC` and the cursor is a
bookmark id.

The `id` is not decoration. `createdAt` alone is not a unique key — bulk imports
and seeded data routinely produce identical timestamps — and a non-unique sort
key makes the cursor ambiguous. The difference is visible in the SQL Prisma
generates (each `@cursor…` below is really an inlined
`(SELECT … FROM "Bookmark" WHERE id = $n)`, elided here for readability):

```sql
-- ORDER BY createdAt, id → a total order; the cursor names exactly one row
WHERE (createdAt = @cursorCreatedAt AND id >= @cursorId)
   OR  createdAt > @cursorCreatedAt
ORDER BY createdAt ASC, id ASC LIMIT 21 OFFSET 1

-- ORDER BY createdAt → matches every tied row, then blindly drops one
WHERE createdAt >= @cursorCreatedAt
ORDER BY createdAt ASC LIMIT 21 OFFSET 1
```

The second form leaves the result to whatever order the query plan happens to
produce, which SQL does not specify — so a page boundary can repeat one row and
skip another. Both composite indexes end in `id` so this sort is served directly
by an index scan.

**Page shape.** The server fetches `take + 1` rows. If the extra row comes back,
it is dropped and `nextCursor` is set to the last returned id; otherwise
`nextCursor` is `null`. So a non-null `nextCursor` always has at least one real
row behind it, clients never receive an empty trailing page, and no `COUNT(*)`
is needed to know whether more exists.

`take` defaults to 20 and is clamped to 100. Clamping rather than erroring: the
request is answerable, and the client gets a valid page plus a cursor to
continue with. `take: 0` or a negative value **is** an error — it expresses a
request that cannot be satisfied, unlike one that is merely too large.

**Known limitation.** `search` compiles to `ILIKE '%term%'`, which no btree index
can accelerate — including `Bookmark(title)`. It is a sequential scan, fine at
this scale and not fine at a million rows. The fix is a `pg_trgm` GIN index,
deliberately not added here: it needs an extension and a raw-SQL migration, and
guessing at scale the assessment did not ask for is its own mistake.

---

## Design decisions

**Prisma is injected through the GraphQL context, never imported by a resolver.**
This is the seam the tests use — a stub or a second client goes in the same way
the real one does. No module mocking anywhere in the suite.

**Validation is dependency-free.** `src/lib/validation.ts` imports nothing and
throws its own `InvalidInputError`; `src/lib/errors.ts` translates that into a
`GraphQLError`. So the rules are testable as plain functions and reusable from a
REST handler or a CLI without dragging GraphQL along.

**`Folder.bookmarks` is a field resolver, so querying folders without it costs
no extra work.** The tradeoff is a classic N+1: `{ folders { bookmarks } }`
issues one query per folder. Accepted deliberately at this scale and documented
in the resolver. The fix is DataLoader — see below.

**`folder(id:)` returns `null` for a missing id; mutations throw `NOT_FOUND`.**
A lookup answering "not there" is a normal answer. A mutation asked for
something to happen, and it did not.

**Errors carry codes, not just messages.** A client can branch on
`BAD_USER_INPUT` versus `NOT_FOUND` without string-matching English prose.

---

## How I'd extend this

Roughly in the order I would actually do it:

1. **DataLoader for `Folder.bookmarks`.** The known N+1. Per-request loader
   batching folder ids into one `WHERE folderId IN (…)`, which is also why the
   Prisma instance is already per-request rather than a module singleton.
2. **Trigram search.** `pg_trgm` + a GIN index on `title`, so `search` stops
   being a sequential scan. Needs a raw-SQL migration.
3. **Tag filtering.** The column is `text[]`; `hasSome`/`hasEvery` plus a GIN
   index would make `bookmarks(tags: [...])` cheap. Left out because the brief
   did not ask for it.
4. **Relay-style connections.** `edges`/`node`/`pageInfo` with opaque base64
   cursors and backwards pagination. The current shape is the same mechanism with
   less ceremony; the migration path is mechanical.
5. **Query cost limits.** Depth and complexity caps before this faces untrusted
   clients — `bookmarks { folder { bookmarks { folder … } } }` is currently
   unbounded.
6. **Structured logging and request ids.** A masked error is deliberately opaque
   to the client, which means the server side needs a correlation id to make it
   diagnosable at all.

### If this became a production system

The six above are things this codebase is asking for. These are things a
production deployment would demand, in rough dependency order:

**Authentication.** A `userId` on `Folder`, resolved from a verified token in
the Yoga context rather than passed as an argument — an id a client can supply
is not an identity. JWT with short expiry plus refresh, or a session cookie if
the only consumer is a first-party web app. The context is already the injection
point, so this lands next to `prisma` rather than threading through resolvers.

**Authorization.** Distinct from the above, and the part that is easy to get
wrong: every query needs the owner predicate pushed into the `where` clause, not
checked after the read. A per-request scoped client (or a Prisma extension that
injects `userId`) makes the safe thing the default, because a filter someone has
to remember is a filter someone will forget. Postgres row-level security is the
stronger version if the threat model justifies it.

**Caching.** Only once there is a measured read pattern to cache. The honest
first step is HTTP caching on the query layer and a persisted-query allow-list;
Redis behind `folders` (small, rarely written, read on every page load) is the
obvious second. Cursor pages are harder to invalidate than they look, so I would
not cache them speculatively.

**Observability.** The masked-error story leaves the server side responsible for
diagnosis: OpenTelemetry traces spanning resolver → Prisma → Postgres, a
request id on every log line and returned in `extensions`, and metrics on p99
latency per operation name plus error rate by `extensions.code`. A rising
`BAD_USER_INPUT` rate is a client regression; a rising `INTERNAL_SERVER_ERROR`
rate is ours, and the two want different alerts.

**API versioning.** GraphQL versions by field rather than by URL: add the new
field, mark the old one `@deprecated` with a reason, and use field-level usage
metrics to know when nobody is asking for it any more. The one thing that needs
a real deprecation window here is the cursor format — it is currently a bare id,
and clients will persist it.

**Scaling.** The server is stateless, so it scales horizontally behind a load
balancer; Postgres is the constraint. In order: PgBouncer for connection pooling
(Bun's per-process pool does not survive many replicas), read replicas for the
list queries, then partitioning only if a single tenant's bookmark table
genuinely outgrows one node — which for a bookmark manager is a long way off,
and saying so is part of the judgment.

### Deliberately not built

Authentication, authorization/RBAC, Federation, Redis caching and deployment
infrastructure. Nothing in the brief needs them, and each would add a dependency
and a failure mode in exchange for functionality no test would exercise. They
are discussed above as extensions instead, which is where they belong until
there is a requirement to point at.

The single-user model is also why `Folder` has no `userId` and no uniqueness
constraint on `name` — folder names are not required to be unique, and inventing
a tenancy model to guard against a problem this API does not have would be
guessing at requirements rather than meeting them.
