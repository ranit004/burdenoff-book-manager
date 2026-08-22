# Runs the GraphQL service itself.
#
# The database is deliberately not part of this image — docker-compose.yml
# supplies Postgres for local development, and a real deployment would point
# DATABASE_URL at a managed instance.

# ---------------------------------------------------------------------------
FROM oven/bun:1.4.0-alpine AS install
WORKDIR /app

# Only the manifest and lockfile, so this layer stays cached until a dependency
# actually changes rather than invalidating on every source edit.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---------------------------------------------------------------------------
FROM oven/bun:1.4.0-alpine AS build
WORKDIR /app

COPY --from=install /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src

# prisma.config.ts resolves the datasource through env('DATABASE_URL'), which
# throws when unset. Generating a client reads only the schema and never opens a
# connection, so a placeholder satisfies this step; the real URL is injected at
# runtime and nothing from this value survives into the image's behaviour.
ENV DATABASE_URL=postgresql://placeholder:placeholder@127.0.0.1:5432/placeholder
RUN bunx prisma generate

# ---------------------------------------------------------------------------
FROM oven/bun:1.4.0-alpine AS prod-deps
WORKDIR /app

# A second install without devDependencies. The build stage needs the Prisma
# CLI and TypeScript; the running server needs neither.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---------------------------------------------------------------------------
FROM oven/bun:1.4.0-alpine
WORKDIR /app

ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/prisma ./prisma
# From the build stage, so the generated Prisma client under src/generated ships
# with the source that imports it.
COPY --from=build /app/src ./src

# The bun images ship a non-root `bun` user. Running as root would be an
# unnecessary blast radius for a process that only needs to read its own code.
USER bun

EXPOSE 4000

# No migrations on startup: applying schema changes is a deploy step, not
# something every replica should race to do on boot.
CMD ["bun", "run", "src/server.ts"]
