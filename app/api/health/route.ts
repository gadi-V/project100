import { NextResponse } from "next/server";
import { missingServiceIds, missingP0ServiceIds, type ServiceId } from "../../../lib/env-validator";
import { prisma } from "../../../lib/prisma";

export const dynamic = "force-dynamic";

/** Neon can take ~5s to wake. Allow one slow attempt to succeed before giving up. */
const DB_PING_TIMEOUT_MS = 5_000;
/** Transient errors during wake: pause, then try again. */
const DB_PING_ATTEMPTS = 5;
const DB_RETRY_DELAY_MS = 1_000;

type HealthStatus = "healthy" | "degraded" | "unhealthy";

type HealthBody = {
  status: HealthStatus;
  latency: { db: string };
  missing_services: ServiceId[];
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function pingDatabase(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), DB_PING_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Ping Neon, waiting 1s between failures. Stops early on the first success.
 * Driver errors are not returned to the caller.
 */
async function pingDatabaseWithRetry(): Promise<{ ok: boolean; latencyMs: number }> {
  const started = Date.now();
  for (let attempt = 1; attempt <= DB_PING_ATTEMPTS; attempt++) {
    try {
      await pingDatabase();
      return { ok: true, latencyMs: Date.now() - started };
    } catch {
      console.error(`[health] database ping failed (attempt ${attempt}/${DB_PING_ATTEMPTS})`);
      if (attempt < DB_PING_ATTEMPTS) await sleep(DB_RETRY_DELAY_MS);
    }
  }
  return { ok: false, latencyMs: Date.now() - started };
}

export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  const db = await pingDatabaseWithRetry();
  // P1 ids follow the keys each client reads (WhatsApp URL+key, Twilio account
  // SID+token+from, Stripe secret+webhook, Supabase URL+service role, Google
  // client id+secret). One id per service.
  const missing = [...new Set(missingServiceIds())];
  const productionP0Gap = process.env.NODE_ENV === "production" && missingP0ServiceIds().length > 0;
  const unhealthy = !db.ok || productionP0Gap;
  const status: HealthStatus = unhealthy ? "unhealthy" : missing.length > 0 ? "degraded" : "healthy";

  const body: HealthBody = {
    status,
    latency: { db: `${db.latencyMs}ms` },
    missing_services: missing,
  };

  return NextResponse.json(body, { status: unhealthy ? 503 : 200, headers });
}
