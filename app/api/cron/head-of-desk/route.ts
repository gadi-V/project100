import { NextResponse } from "next/server";
import { verifyCronRequest } from "../../../../lib/auth/cron";
import { isHiveMonitorBearer } from "../../../../lib/hive-m2m-auth";
import { writeAuditLog } from "../../../../lib/audit";

/**
 * Head of Desk quiet-monitor cron — pulls the CRITICAL risk surface built by
 * `app/api/admin/audit/risk-events` and records the result to AuditLog.
 *
 * Quiet by default: when there are no critical events the route returns
 * `{ quiet: true, critical: 0 }` WITHOUT alerting anyone (the manager only gets
 * a message when an exclusive precondition is violated — see head_of_desk.py).
 *
 * Auth: Authorization: Bearer <CRON_SECRET> (Vercel Cron / QStash), a verified
 * QStash signature, or Bearer <HIVE_MONITOR_SECRET> (agents_hive, smoke tests).
 * Fails closed when none is configured.
 */
export async function GET(request: Request) {
  try {
    if (!(await isAuthorized(request))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // risk-events only trusts HIVE_MONITOR_SECRET, so a Vercel Cron call (CRON_SECRET) must not be forwarded as-is.
    const monitorSecret = process.env.HIVE_MONITOR_SECRET?.trim();
    const resolved = await fetch(
      `${new URL(request.url).origin}/api/admin/audit/risk-events`,
      {
        headers: {
          authorization: monitorSecret
            ? `Bearer ${monitorSecret}`
            : request.headers.get("authorization") ?? "",
        },
      }
    ).catch(() => null);

    if (!resolved || !resolved.ok) {
      return NextResponse.json(
        { error: "risk-events probe failed" },
        { status: 502 }
      );
    }

    const data = (await resolved.json()) as {
      events?: Array<{ severity?: string; id?: string }>;
      error?: string;
    };
    const critical = (data.events ?? []).filter(
      (e) => e.severity === "CRITICAL"
    );

    // Record sweep outcome — always append (immutable audit trail), never delete.
    await writeAuditLog({
      action: critical.length > 0 ? "HOD_CRITICAL_SWEEP" : "HOD_QUIET_SWEEP",
      entityType: "HeadOfDesk",
      entityId: critical.map((c) => c.id).join(",") || "quiet",
      metadata: {
        criticalCount: critical.length,
        totalEvents: data.events?.length ?? 0,
        drivenBy: "cron",
      },
    });

    return NextResponse.json({
      success: true,
      quiet: critical.length === 0,
      critical: critical.length,
      eventIds: critical.map((c) => c.id),
    });
  } catch (error: unknown) {
    console.error("[head-of-desk cron] error:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}

export const POST = GET;

async function isAuthorized(request: Request): Promise<boolean> {
  return (await verifyCronRequest(request)) || isHiveMonitorBearer(request);
}