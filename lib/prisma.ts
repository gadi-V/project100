import { config as loadEnv } from "dotenv";
import { resolve } from "path";
import { PrismaClient } from "@prisma/client";

// Ensure .env is loaded even if the process was started without it
loadEnv({ path: resolve(process.cwd(), ".env") });

/**
 * Used only when DATABASE_URL is unset (e.g. Vercel build without project secrets).
 * Never a live pool — production must set the Neon pooled URL instead.
 */
const BUILD_FALLBACK_DATABASE_URL =
  "postgresql://dummy:dummy@localhost:5432/dummy";

/**
 * Production `DATABASE_URL` MUST be the Neon pooled connection string:
 * the hostname contains `-pooler`, and the query string includes
 * `pgbouncer=true` plus `connection_limit=1`.
 *
 * PgBouncer (Neon pooler) cannot use Prisma prepared statements, so
 * `pgbouncer=true` is required on that host. `connection_limit=1` keeps each
 * serverless isolate to a single connection; the pooler multiplexes them.
 * Use the direct (non-pooler) Neon URL only for `prisma migrate`.
 */
const POOLER_HOST = /-pooler[./]/;
const PGBOUNCER_TRUE = /(?:\?|&)pgbouncer=true(?:&|$)/;
const CONNECTION_LIMIT = /(?:\?|&)connection_limit=/;

let warnedDirectDatabaseUrl = false;

function warnIfProductionDirectUrl(): void {
  if (process.env.NODE_ENV !== "production") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (warnedDirectDatabaseUrl) return;
  warnedDirectDatabaseUrl = true;
  console.warn(
    "[prisma] DATABASE_URL is not a Neon pooled connection string. " +
      "Production must use the pooler host (`-pooler`) with `?pgbouncer=true&connection_limit=1` " +
      "or serverless isolates will exhaust database connections. " +
      "Keep the direct Neon URL for migrations only."
  );
}

/** Fill pooler flags when the URL already targets Neon PgBouncer. Does not rewrite a direct host. */
function applyNeonPoolerDefaults(url: string): string {
  if (url === BUILD_FALLBACK_DATABASE_URL) return url;
  const poolerHost = POOLER_HOST.test(url);
  const pgbouncer = PGBOUNCER_TRUE.test(url);
  if (!poolerHost && !pgbouncer) {
    warnIfProductionDirectUrl();
    return url;
  }
  const extras: string[] = [];
  if (poolerHost && !pgbouncer) extras.push("pgbouncer=true");
  if (!CONNECTION_LIMIT.test(url)) extras.push("connection_limit=1");
  if (extras.length === 0) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${extras.join("&")}`;
}

function resolveDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim() || BUILD_FALLBACK_DATABASE_URL;
  if (!url.startsWith("postgresql://") && !url.startsWith("postgres://")) {
    throw new Error(
      `DATABASE_URL must start with postgresql:// or postgres:// (got "${url.slice(0, 24)}..."). Check that .env has a newline between variables.`
    );
  }
  return applyNeonPoolerDefaults(url);
}

/**
 * Hot-reload cache. Next.js re-evaluates this module on every save in
 * development; without this, each reload constructs a new PrismaClient and
 * leaks a connection pool. Production does not attach here — the isolate
 * keeps a single module-scoped client instead (see `productionPrisma`).
 */
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

/** One client per production isolate. Module scope is stable for the life of the lambda. */
let productionPrisma: PrismaClient | undefined;

function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    datasources: {
      db: { url: resolveDatabaseUrl() },
    },
  });
}

/**
 * Lazy Prisma accessor — client is constructed on first property access, not at
 * module import. Prisma does not open a TCP connection until a query runs, so
 * Next.js static/page-data collection can import this module during build
 * without a live database.
 *
 * Development: reuse the client stored on `globalThis` across hot reloads.
 * Production: reuse one client for the serverless isolate. Do not create a
 * client per request — that exhausts Neon connections.
 */
function getPrismaClient(): PrismaClient {
  if (process.env.NODE_ENV !== "production") {
    if (!globalForPrisma.prisma) {
      globalForPrisma.prisma = createPrismaClient();
    }
    return globalForPrisma.prisma;
  }
  if (!productionPrisma) {
    productionPrisma = createPrismaClient();
  }
  return productionPrisma;
}

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const client = getPrismaClient();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
