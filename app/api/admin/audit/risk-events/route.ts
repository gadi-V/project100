import { NextRequest, NextResponse } from "next/server";
import { prisma } from "../../../../../lib/prisma";
import { requireAuth } from "../../../../../lib/api-auth";

/**
 * Head of Desk risk-events surface (שכבת הפיקוד השקט).
 *
 * GET only — computes the EXCLUSIVE critical risk preconditions for the quiet
 * monitoring layer, so the Head of Desk never sends idle alerts:
 *
 *   1. NO_TEACHER_ASSIGNED — a student paid for a package but was not assigned
 *      a teacher within two hours (no unlock + no referral + no lesson).
 *   2. STRIPE_FAILURE — a Stripe webhook event failed processing / an error was
 *      recorded, or a duplicated ledger transactionId (double-write) signals a
 *      settlement imbalance in BillingLedger.
 *   3. TEACHER_NO_SHOW — a lesson whose scheduledAt has passed by 3 minutes and
 *      is still SCHEDULED (room never opened), within the recent window.
 *
 * Auth: the monitoring scanner authenticates via `Authorization: Bearer
 * HIVE_MONITOR_SECRET` (server-to-server). When the secret is unset, requires an
 * ADMIN/MANAGER session instead.
 */

type RiskKind =
  | "NO_TEACHER_ASSIGNED"
  | "STRIPE_FAILURE"
  | "LEDGER_IMBALANCE"
  | "TEACHER_NO_SHOW";

type RiskEvent = {
  id: string;
  severity: "CRITICAL" | "WARNING";
  kind: RiskKind;
  title: string;
  description: string;
  playerId: string;
  createdAt: string;
  payload: Record<string, unknown>;
};

const KIND_MAP: Record<string, RiskKind> = {
  NO_TEACHER_ASSIGNED: "NO_TEACHER_ASSIGNED",
  STRIPE_FAILURE: "STRIPE_FAILURE",
  LEDGER_IMBALANCE: "LEDGER_IMBALANCE",
  TEACHER_NO_SHOW: "TEACHER_NO_SHOW",
};

async function isAuthorized(request: NextRequest): Promise<boolean> {
  const secret = process.env.HIVE_MONITOR_SECRET;
  const auth = request.headers.get("authorization") ?? "";
  if (secret && auth === `Bearer ${secret}`) {
    return true;
  }
  // No secret configured → fall back to admin session guardrail.
  const session = await requireAuth(["ADMIN", "MANAGER"]);
  return !session.error;
}

async function computeNoTeacherAssigned(): Promise<RiskEvent[]> {
  const since = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours
  // One query for payments + student. Assignment checks are three batched
  // lookups by student id, not a query per payment (that was 1 + 4N round trips).
  const recentPayments = await prisma.payment.findMany({
    where: { createdAt: { gte: since }, status: "COMPLETED" },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      studentId: true,
      packageType: true,
      amountPaid: true,
      createdAt: true,
      student: { select: { id: true, name: true, lessonCredits: true } },
    },
  });

  const studentIds = [...new Set(recentPayments.map((payment) => payment.studentId))];
  if (studentIds.length === 0) return [];

  const [unlockedDiagnostics, referrals, upcomingLessons] = await Promise.all([
    prisma.diagnosticQuiz.findMany({
      where: { studentId: { in: studentIds }, isUnlocked: true },
      select: { studentId: true },
      distinct: ["studentId"],
    }),
    prisma.teacherReferral.findMany({
      where: { studentId: { in: studentIds } },
      select: { studentId: true },
      distinct: ["studentId"],
    }),
    prisma.lesson.findMany({
      where: { studentId: { in: studentIds }, status: { in: ["SCHEDULED", "IN_PROGRESS"] } },
      select: { studentId: true },
      distinct: ["studentId"],
    }),
  ]);

  const assignedStudentIds = new Set<string>([
    ...unlockedDiagnostics.map((row) => row.studentId),
    ...referrals.map((row) => row.studentId),
    ...upcomingLessons.map((row) => row.studentId),
  ]);

  const events: RiskEvent[] = [];
  for (const payment of recentPayments) {
    const student = payment.student;
    if (!student || assignedStudentIds.has(student.id)) continue;

    events.push({
      id: `no-teacher-${payment.id}`,
      severity: "CRITICAL",
      kind: "NO_TEACHER_ASSIGNED",
      title: "תלמיד שילם על חבילה ללא שיבוץ מורה (2h)",
      description: `התלמיד "${student.name || student.id}" שילם על ${payment.packageType} אך לא שובץ מורה תוך שעתיים.`,
      playerId: student.id,
      createdAt: payment.createdAt.toISOString(),
      payload: {
        paymentId: payment.id,
        packageType: payment.packageType,
        amountPaid: payment.amountPaid,
        lessonCredits: student.lessonCredits,
      },
    });
  }
  return events;
}

async function computeStripeAndLedger(): Promise<RiskEvent[]> {
  const events: RiskEvent[] = [];
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // 2a) Stripe webhooks that failed processing in the last 24h.
  const failedWebhooks = await prisma.webhookEvent.findMany({
    where: {
      provider: "stripe",
      processed: false,
      error: { not: null },
      createdAt: { gte: dayAgo },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  for (const wh of failedWebhooks) {
    events.push({
      id: `stripe-${wh.id}`,
      severity: "CRITICAL",
      kind: "STRIPE_FAILURE",
      title: "כשל סליקה ב-Stripe",
      description: `Webhook ${wh.eventType} (${wh.externalId}) נכשל בעיבוד: ${wh.error}`,
      playerId: wh.id,
      createdAt: wh.createdAt.toISOString(),
      payload: { eventType: wh.eventType, externalId: wh.externalId },
    });
  }

  // 2b) Ledger imbalance: duplicated transactionId = double-write (idempotency breach).
  const dupTxs = await prisma.$queryRaw<
    { transactionid: string; cnt: bigint }[]
  >`
    SELECT "transactionId" AS transactionid, COUNT(*)::bigint AS cnt
    FROM "BillingLedger"
    WHERE "transactionId" IS NOT NULL
    GROUP BY "transactionId"
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
    LIMIT 50
  `;
  const txIds = dupTxs.map((row) => String(row.transactionid));
  const entriesByTx = new Map<string, { userId: string; createdAt: Date; entryType: string }[]>();
  if (txIds.length > 0) {
    const entries = await prisma.billingLedger.findMany({
      where: { transactionId: { in: txIds } },
      orderBy: { createdAt: "asc" },
      select: { transactionId: true, userId: true, createdAt: true, entryType: true },
    });
    for (const entry of entries) {
      const key = entry.transactionId ?? "";
      const bucket = entriesByTx.get(key) ?? [];
      if (bucket.length >= 10) continue;
      bucket.push({ userId: entry.userId, createdAt: entry.createdAt, entryType: entry.entryType });
      entriesByTx.set(key, bucket);
    }
  }
  for (const row of dupTxs) {
    const entries = entriesByTx.get(String(row.transactionid)) ?? [];
    events.push({
      id: `ledger-dup-${row.transactionid}`,
      severity: "CRITICAL",
      kind: "LEDGER_IMBALANCE",
      title: "איזון תנועות חסר ב-BillingLedger (כפילות)",
      description: `מפתח idempotency "${row.transactionid}" מופיע ${row.cnt} פעמים — סימן לכתיבה כפולה בספר החשבונות.`,
      playerId: entries[0]?.userId ?? "unknown",
      createdAt: entries[0]?.createdAt.toISOString() ?? new Date().toISOString(),
      payload: {
        transactionId: String(row.transactionid),
        count: Number(row.cnt),
        entryTypes: entries.map((e) => e.entryType),
      },
    });
  }
  return events;
}

async function computeTeacherNoShow(): Promise<RiskEvent[]> {
  const now = Date.now();
  const since = now - 2 * 60 * 60 * 1000; // recent window (avoid legacy stale rows)
  const noShowWindowEnd = now - 3 * 60 * 1000; // scheduledAt + 3 minutes passed

  const staleScheduled = await prisma.lesson.findMany({
    where: {
      status: "SCHEDULED",
      scheduledAt: { lte: new Date(noShowWindowEnd), gte: new Date(since) },
    },
    orderBy: { scheduledAt: "asc" },
    take: 100,
    include: {
      teacher: { select: { id: true, name: true } },
      student: { select: { id: true, name: true } },
    },
  });

  return staleScheduled.map((lesson) => ({
    id: `no-show-${lesson.id}`,
    severity: "CRITICAL" as const,
    kind: "TEACHER_NO_SHOW" as const,
    title: "מורה לא התייצב בחדר השיעור (3 דקות)",
    description: `השיעור של "${lesson.student.name || lesson.student.id}" עם "${lesson.teacher.name || lesson.teacher.id}" טרם נפתח 3 דקות לאחר המועד.`,
    playerId: lesson.id,
    createdAt: lesson.scheduledAt.toISOString(),
    payload: {
      lessonId: lesson.id,
      teacherId: lesson.teacherId,
      scheduledAt: lesson.scheduledAt.toISOString(),
      roomUrl: lesson.dailyRoomUrl ?? null,
    },
  }));
}

export async function GET(request: NextRequest) {
  try {
    if (!(await isAuthorized(request))) {
      return NextResponse.json({ error: "אין הרשאה לניטור" }, { status: 401 });
    }

    const kindParam = request.nextUrl.searchParams.get("kind");
    const kinds: RiskKind[] = kindParam
      ? KIND_MAP[kindParam]
        ? [KIND_MAP[kindParam]]
        : []
      : (Object.values(KIND_MAP) as RiskKind[]);

    let events: RiskEvent[] = [];
    if (kinds.includes("NO_TEACHER_ASSIGNED")) {
      events = events.concat(await computeNoTeacherAssigned());
    }
    if (kinds.includes("STRIPE_FAILURE") || kinds.includes("LEDGER_IMBALANCE")) {
      events = events.concat(await computeStripeAndLedger());
    }
    if (kinds.includes("TEACHER_NO_SHOW")) {
      events = events.concat(await computeTeacherNoShow());
    }

    events.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return NextResponse.json({ events, nextCursor: null });
  } catch (error: unknown) {
    console.error("[risk-events] error:", error);
    return NextResponse.json(
      { events: [], nextCursor: null, error: "שגיאה בחישוב אירועי סיכון" },
      { status: 500 }
    );
  }
}
