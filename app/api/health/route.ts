import { NextResponse } from "next/server";
import { prisma } from "../../../lib/prisma";

export const dynamic = "force-dynamic";

const DB_PING_TIMEOUT_MS = 5_000;

/**
 * Public liveness + readiness probe. `200 UP` only when a live `SELECT 1`
 * round-trip to the Neon database succeeds; otherwise `503 DOWN`.
 * Never exposes connection strings or driver error details.
 */
export async function GET() {
  const startedAt = Date.now();
  const headers = { "Cache-Control": "no-store" };

  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("DB ping timed out")), DB_PING_TIMEOUT_MS)
      ),
    ]);

    return NextResponse.json(
      {
        success: true,
        data: {
          status: "UP",
          database: "UP",
          latencyMs: Date.now() - startedAt,
          timestamp: new Date().toISOString(),
        },
      },
      { status: 200, headers }
    );
  } catch (error: unknown) {
    console.error("[health] database check failed:", error instanceof Error ? error.message : error);
    return NextResponse.json(
      {
        success: false,
        error: "Database unreachable",
        data: {
          status: "DOWN",
          database: "DOWN",
          latencyMs: Date.now() - startedAt,
          timestamp: new Date().toISOString(),
        },
      },
      { status: 503, headers }
    );
  }
}
