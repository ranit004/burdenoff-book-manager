/**
 * Environment configuration.
 *
 * Bun loads `.env` automatically, so this module's only job is to read the
 * values, fail loudly if a required one is missing, and hand back a typed
 * object. Deliberately side-effect-free on import: nothing is validated until
 * `loadEnv()` is called, which keeps it unit-testable and stops a missing
 * variable from breaking unrelated imports.
 */

export interface Env {
  readonly DATABASE_URL: string;
  readonly PORT: number;
}

export class MissingEnvVarError extends Error {
  constructor(name: string) {
    super(`Missing required environment variable "${name}". Copy .env.example to .env first.`);
    this.name = 'MissingEnvVarError';
  }
}

const DEFAULT_PORT = 4000;
const MAX_PORT = 65535;

type EnvSource = Record<string, string | undefined>;

function requireString(source: EnvSource, name: string): string {
  const value = source[name]?.trim();
  if (value === undefined || value === '') {
    throw new MissingEnvVarError(name);
  }
  return value;
}

function readPort(source: EnvSource): number {
  const raw = source.PORT?.trim();
  if (raw === undefined || raw === '') {
    return DEFAULT_PORT;
  }

  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > MAX_PORT) {
    throw new Error(`Invalid PORT "${raw}": expected an integer between 1 and ${MAX_PORT}.`);
  }
  return port;
}

export function loadEnv(source: EnvSource = process.env): Env {
  return {
    DATABASE_URL: requireString(source, 'DATABASE_URL'),
    PORT: readPort(source),
  };
}
