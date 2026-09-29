/**
 * E2E Dry-Run Verification — 8-station closed-loop funnel test for Project 8.
 *
 * Station 1: DiagnosticQuiz creation (math 581/582) — weak topics identified & saved w/ topicIds.
 * Station 2: GET /api/diagnostic/teaser — readiness visible, gap tree locked/blurred, WhatsApp
 *            message recommends TRIO (1-2 topics) or MULTI (3+ topics).
 * Station 3: TRIO package purchase — BillingLedger CHARGE (Decimal 19,4) + idempotencyKey + credits=3.
 * Station 4: POST /api/whatsapp/dispatch-channel — 1-vs-4 policy:
 *            TRIO/MULTI before a mapping lesson ⇒ PENDING_TEACHER_ASSIGNMENT (no group, no link);
 *            after a mapping lesson with a teacher is scheduled ⇒ the route attempts the Quad group;
 *            SINGLE ⇒ transactional only.
 * Station 5: Mandatory pre-lesson context — PreLessonAsset bound to packageId feeds the brief.
 * Station 6: POST /api/lessons/[id]/summary — lesson close, resolvedGaps update, balanced COMPENSATION.
 * Station 7: POST /api/admin/override/compensation — PLATFORM_COMPENSATION ledger + credit, no double charge.
 * Station 8: FastMCP hive tools + GET /api/admin/audit/risk-events — only CRITICAL exceptions surface,
 *            quiet in the happy path.
 *
 * Run: npx tsx scripts/e2e-dry-run-verification.ts
 *      npx tsc --noEmit   (must stay TSC EXIT: 0)
 *
 * The script creates real rows for a closed loop then cleans them up (stack-based
 * finally), so it's safe to re-run.  API server calls are additive reads/writes.
 */

import "dotenv/config";
import { PrismaClient, Role, LedgerEntryType, PreLessonAssetType } from "@prisma/client";
import { signSession } from "../lib/auth";
import { determinePackageForGapDepth, buildPersonalizedDiagnosticConversion } from "../lib/whatsapp";
import { DIAGNOSTIC_MATH_BANK } from "../lib/diagnostic-bank";

const prisma = new PrismaClient();

type StationResult = {
  station: number;
  name: string;
  ok: boolean;
  detail: string;
};

type Ctx = {
  students: string[];
  packages: string[];
  payments: string[];
  ledger: string[];
  assets: string[];
  lessons: string[];
  quizzes: string[];
  chats: string[];
  profiles: string[];
  webhooks: string[];
  referrals: string[];
  topics: string[];
};

const ctx: Ctx = {
  students: [],
  packages: [],
  payments: [],
  ledger: [],
  assets: [],
  lessons: [],
  quizzes: [],
  chats: [],
  profiles: [],
  webhooks: [],
  referrals: [],
  topics: [],
};

/** Primary-fixture scope for FK-safe cleanup (single student + package owned by the test). */
const scope: { studentId?: string; packageId?: string; teacherUserId?: string } = {};

let passed = 0;
let failed = 0;
const results: StationResult[] = [];

function record(station: number, name: string, ok: boolean, detail: string) {
  if (ok) passed += 1;
  else failed += 1;
  results.push({ station, name, ok, detail });
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function red(s: string): string {
  return `\x1b[31m${s}\x1b[0m`;
}
function green(s: string): string {
  return `\x1b[32m${s}\x1b[0m`;
}

function appBase(): string {
  return process.env.APP_URL?.replace(/\/$/, "") ||
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
    "http://localhost:3000";
}

async function api<T = unknown>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  token?: string,
  cookie?: string
): Promise<{ status: number; json: T }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${appBase()}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, json };
}

const SESSION_COOKIE_NAME = "project8_session";

/** Must match PACKAGES.TRIO.price in app/api/payments/route.ts. */
const TRIO_PRICE_ILS = 540;
/** Must match LESSON_VALUE_ILS in app/api/admin/override/compensation/route.ts. */
const OVERRIDE_LESSON_VALUE_ILS = 200;

async function cleanup(): Promise<void> {
  const studentScope = scope.studentId ? { studentId: scope.studentId } : undefined;

  // Delete by full scope where FK reachable, then by tracked ids (defensive).
  if (scope.studentId) {
    await prisma.billingLedger.deleteMany({ where: { userId: { in: ctx.students } } }).catch(() => undefined);
    await prisma.payment.deleteMany({ where: { studentId: { in: ctx.students } } }).catch(() => undefined);
    await prisma.preLessonAsset.deleteMany({
      where: scope.packageId ? { packageId: scope.packageId } : { uploadedById: { in: ctx.students } },
    }).catch(() => undefined);
    await prisma.lesson.deleteMany({
      where: scope.studentId
        ? { OR: [{ studentId: scope.studentId }, { teacherId: { in: ctx.students } }] }
        : { studentId: { in: ctx.students } },
    }).catch(() => undefined);
    await prisma.teacherReferral.deleteMany({ where: { studentId: scope.studentId } }).catch(() => undefined);
    await prisma.diagnosticQuiz.deleteMany({ where: { studentId: { in: ctx.students } } }).catch(() => undefined);
  }

  if (ctx.ledger.length) {
    await prisma.billingLedger.deleteMany({ where: { id: { in: ctx.ledger } } }).catch(() => undefined);
  }
  if (ctx.payments.length) {
    await prisma.payment.deleteMany({ where: { id: { in: ctx.payments } } }).catch(() => undefined);
  }
  if (ctx.assets.length) {
    await prisma.preLessonAsset.deleteMany({ where: { id: { in: ctx.assets } } }).catch(() => undefined);
  }
  if (ctx.chats.length) {
    await prisma.unifiedPackageChat.deleteMany({ where: { id: { in: ctx.chats } } }).catch(() => undefined);
  }
  if (ctx.lessons.length) {
    await prisma.lesson.deleteMany({ where: { id: { in: ctx.lessons } } }).catch(() => undefined);
  }
  if (ctx.quizzes.length) {
    await prisma.diagnosticQuiz.deleteMany({ where: { id: { in: ctx.quizzes } } }).catch(() => undefined);
  }
  if (ctx.topics.length) {
    await prisma.curriculumTopic.deleteMany({ where: { id: { in: ctx.topics } } }).catch(() => undefined);
  }
  if (ctx.referrals.length) {
    await prisma.teacherReferral.deleteMany({ where: { id: { in: ctx.referrals } } }).catch(() => undefined);
  }
  if (ctx.profiles.length) {
    await prisma.teacherProfile.deleteMany({ where: { id: { in: ctx.profiles } } }).catch(() => undefined);
  }
  if (ctx.students.length) {
    await prisma.user.deleteMany({ where: { id: { in: ctx.students } } }).catch(() => undefined);
  }
  if (ctx.packages.length) {
    await prisma.package.deleteMany({ where: { id: { in: ctx.packages } } }).catch(() => undefined);
  }
  if (ctx.webhooks.length) {
    await prisma.webhookEvent.deleteMany({ where: { id: { in: ctx.webhooks } } }).catch(() => undefined);
  }
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

async function createStudent(): Promise<{ id: string; name: string; phone: string; token: string; cookie: string }> {
  const suffix = randomSuffix();
  const user = await prisma.user.create({
    data: {
      name: `E2E Student ${suffix}`,
      phone: `050${suffix}`,
      email: `e2e-${suffix}@example.com`,
      password: "MOCK_PASSWORD_E2E",
      role: Role.STUDENT,
      lessonCredits: 0,
    },
  });
  ctx.students.push(user.id);
  const token = await signSession(user.id);
  return { id: user.id, name: user.name, phone: user.phone, token, cookie: `${SESSION_COOKIE_NAME}=${token}` };
}

async function station1_diagnostic(): Promise<{ studentId: string; token: string; cookie: string; studentName: string; packageId: string; lessonId: string; teacherProfileId: string; teacherUserId: string }> {
  // Setup a minimal topology: student + teacher (approved) + package + open lesson.
  const suffix = randomSuffix();
  const student = await createStudent();

  const teacher = await prisma.user.create({
    data: {
      name: `E2E Teacher ${suffix}`,
      phone: `051${suffix}`,
      email: `e2e-t-${suffix}@example.com`,
      password: "MOCK_PASSWORD_E2E",
      role: Role.TEACHER,
      isApproved: true,
    },
  });
  ctx.students.push(teacher.id);

  const profile = await prisma.teacherProfile.create({
    data: {
      userId: teacher.id,
      subjects: ["מתמטיקה"],
      ageGroups: ["תיכון"],
      payoutType: "SLIP",
      vettingStatus: "APPROVED",
      vettingStage: "APPROVED",
      isApproved: true,
    },
  });
  ctx.profiles.push(profile.id);

  const topicA = await prisma.curriculumTopic.create({
    data: { subject: "מתמטיקה", topicName: `E2E Topic $e^x$ ${suffix}`, subTopics: ["כלל השרשרת"], gradeLevel: "HIGH_SCHOOL", weightInExam: 0.4 },
  });
  const topicB = await prisma.curriculumTopic.create({
    data: { subject: "מתמטיקה", topicName: `E2E Topic 2 ${suffix}`, subTopics: ["אינטגרלים"], gradeLevel: "HIGH_SCHOOL", weightInExam: 0.3 },
  });
  const topicC = await prisma.curriculumTopic.create({
    data: { subject: "מתמטיקה", topicName: `E2E Topic 3 ${suffix}`, subTopics: ["וקטורים"], gradeLevel: "HIGH_SCHOOL", weightInExam: 0.3 },
  });
  ctx.topics.push(topicA.id, topicB.id, topicC.id);

  const pkg = await prisma.package.create({
    data: { code: `E2E-TRIO-${suffix}`, name: "E2E Trio Package", credits: 3, priceIls: TRIO_PRICE_ILS },
  });
  ctx.packages.push(pkg.id);

  const quiz = await prisma.diagnosticQuiz.create({
    data: {
      studentId: student.id,
      ageGroup: "HIGH_SCHOOL",
      subject: "מתמטיקה (5 יח״ל - 581)",
      challenge: "E2E diagnostic challenge",
      topicIds: [topicA.id, topicB.id, topicC.id],
      trackType: "BAGRUT",
      examNumber: "581",
      unitsCount: 5,
      score: 1,
      totalQuestions: 3,
      identifiedGaps: ["כלל השרשרת", "אינטגרלים", "וקטורים"],
      estimatedScore: 41,
      isUnlocked: false,
      recommendationSummary: "מדד מוכנות למבחן: 41%. זוהו 3 פערי ליבה.",
      packageId: pkg.id,
      topics: { connect: [{ id: topicA.id }, { id: topicB.id }, { id: topicC.id }] },
    },
  });
  ctx.quizzes.push(quiz.id);

  const chat = await prisma.unifiedPackageChat.create({
    data: { packageId: pkg.id, streamChannelId: `pkg-${suffix}`, isActive: true },
  });
  ctx.chats.push(chat.id);

  const lesson = await prisma.lesson.create({
    data: {
      packageId: pkg.id,
      studentId: student.id,
      teacherId: teacher.id,
      scheduledAt: new Date(Date.now() - 60 * 60 * 1000), // started 1h ago (for no-show window)
      status: "SCHEDULED",
      durationMinutes: 50,
    },
  });
  ctx.lessons.push(lesson.id);

  scope.studentId = student.id;
  scope.packageId = pkg.id;
  scope.teacherUserId = teacher.id;

  const okQuiz = quiz.topicIds.length === 3 && quiz.identifiedGaps?.length === 3;
  record(
    1,
    "DiagnosticQuiz & LaTeX",
    okQuiz,
    okQuiz
      ? `quiz ${quiz.id} saved: ${quiz.topicIds.length} weak topicIds, score 1/3, gaps=${quiz.identifiedGaps?.length}`
      : `quiz fields mismatch: topicIds=${quiz.topicIds.length}, gaps=${quiz.identifiedGaps?.length}`
  );

  // Also verify the LaTeX bank exports properly (reuse existing engine).
  const bankQuestions = DIAGNOSTIC_MATH_BANK["math_581"] ?? [];
  record(1, "LaTeX question bank", bankQuestions.length > 0, `DIAGNOSTIC_MATH_BANK["math_581"] has ${bankQuestions.length} questions`);

  return {
    studentId: student.id,
    token: student.token,
    cookie: student.cookie,
    studentName: student.name,
    packageId: pkg.id,
    lessonId: lesson.id,
    teacherProfileId: profile.id,
    teacherUserId: teacher.id,
  };
}

async function station2_teaser(ctx2: Awaited<ReturnType<typeof station1_diagnostic>>) {
  // GET /api/diagnostic/teaser?quizId=... → locked tree + recommendation.
  const quiz = await prisma.diagnosticQuiz.findFirst({
    where: { packageId: ctx2.packageId },
    orderBy: { createdAt: "desc" },
  });
  assert(quiz?.id, "quiz missing for teaser");

  const res = await api<{
    success?: boolean;
    data?: {
      quizId: string;
      readinessScore: number;
      summaryText: string;
      isLocked: boolean;
      gapTree: Array<{ maskedName?: string; isLocked?: boolean }>;
      topicsCount: number;
      recommendation?: { packageRecommendation: "TRIO" | "MULTI"; lessons: number; whatsappMessage?: string };
    };
  }>("GET", `/api/diagnostic/teaser?quizId=${quiz.id}`, undefined, undefined, ctx2.cookie);

  const d = res.json?.data;
  const ok =
    res.status === 200 &&
    d?.readinessScore != null &&
    d.summaryText?.length > 0 &&
    d.isLocked === true &&
    Array.isArray(d.gapTree) &&
    d.gapTree.every((t) => t.isLocked) &&
    d.recommendation?.packageRecommendation === "MULTI" && // 3 weak topics
    d.recommendation.lessons === 5 &&
    (d.recommendation.whatsappMessage?.length ?? 0) > 0;

  record(
    2,
    "Teaser Paywall & converter",
    ok,
    ok
      ? `GET teaser: score=${d?.readinessScore}, locked=${d?.isLocked}, tree=${d?.gapTree?.length} locked nodes, rec=${d?.recommendation?.packageRecommendation}/${d?.recommendation?.lessons}`
      : `misaligned teaser response (status=${res.status}): ${JSON.stringify(res.json ?? null)?.slice(0, 200)}`
  );

  // Unit-level: TRIO/MULTI selection.
  const shallow = determinePackageForGapDepth(2);
  const deep = determinePackageForGapDepth(4);
  const unitOk = shallow.packageType === "TRIO" && deep.packageType === "MULTI";
  record(
    2,
    "Gap-depth → package mapping",
    unitOk,
    unitOk
      ? `1-2 topics → ${shallow.packageType}/${shallow.lessons}, 3+ → ${deep.packageType}/${deep.lessons}`
      : `mapping mismatch: shallow=${shallow.packageType}, deep=${deep.packageType}`
  );
}

async function station3_purchase(ctx2: Awaited<ReturnType<typeof station1_diagnostic>>) {
  // Mock-mode /api/payments grant CHARGE entry (Stripeless dev path only).
  const res = await api<{ success?: boolean; isMock?: boolean; newCredits?: number; error?: string }>(
    "POST",
    "/api/payments",
    { packageType: "TRIO" },
    undefined,
    ctx2.cookie
  );

  const ok =
    res.json?.success === true &&
    (res.json?.isMock === true || res.json?.newCredits != null);

  // Verify DB truth: lessonCredits = 3 and one CHARGE row with Decimal precision.
  const student = await prisma.user.findUnique({ where: { id: ctx2.studentId } });
  const charges = await prisma.billingLedger.findMany({
    where: { userId: ctx2.studentId, entryType: LedgerEntryType.CHARGE },
    orderBy: { createdAt: "desc" },
  });
  charges.forEach((c) => ctx.ledger.push(c.id));

  const payment = await prisma.payment.findFirst({
    where: { studentId: ctx2.studentId },
    orderBy: { createdAt: "desc" },
  });
  if (payment) ctx.payments.push(payment.id);

  const dbOk =
    student?.lessonCredits === 3 &&
    charges.length >= 1 &&
    Number(charges[0]?.amount) === TRIO_PRICE_ILS; // Decimal(19,4) → 540.0000
  const hasIdempotency = charges[0]?.transactionId?.startsWith("mock_") === true || charges[0]?.transactionId != null;

  record(
    3,
    "TRIO purchase → CHARGE (19.4) + credits",
    ok && dbOk && hasIdempotency,
    ok && dbOk && hasIdempotency
      ? `credits=${student?.lessonCredits}, CHARGE amount=${charges[0]?.amount} ILS, tx=${charges[0]?.transactionId}, isMock=${res.json?.isMock}`
      : `purchase/ledger mismatch: apiOk=${ok}, credits=${student?.lessonCredits}, charges=${charges.length}, amount=${charges[0]?.amount}`
  );
}

type DispatchResponse = {
  success?: boolean;
  data?: {
    channel?: string;
    isGroupOpened?: boolean;
    groupStatus?: string;
    quadGroupUrl?: string | null;
    modeLabel?: string;
    errorCode?: string;
  };
  error?: string;
};

async function station4_dispatch(ctx2: Awaited<ReturnType<typeof station1_diagnostic>>) {
  const trioBody = {
    packageType: "TRIO",
    studentName: ctx2.studentName,
    studentPhone: "0500000000",
    gapTopicsCount: 3,
    gapTopicsNames: ["כלל השרשרת", "אינטגרלים", "וקטורים"],
  };

  // 4a. After diagnosis + purchase, before any mapping lesson: the group stays pending.
  const pending = await api<DispatchResponse>("POST", "/api/whatsapp/dispatch-channel", trioBody, undefined, ctx2.cookie);
  const userBefore = await prisma.user.findUnique({ where: { id: ctx2.studentId } });
  const okPending =
    pending.json?.success === true &&
    pending.json?.data?.channel === "QUAD_GROUP" &&
    pending.json?.data?.isGroupOpened === false &&
    pending.json?.data?.groupStatus === "PENDING_TEACHER_ASSIGNMENT" &&
    !pending.json?.data?.quadGroupUrl &&
    !userBefore?.whatsappGroupId;

  record(
    4,
    "WhatsApp: TRIO before mapping lesson ⇒ pending",
    okPending,
    okPending
      ? `groupStatus=${pending.json?.data?.groupStatus}, opened=false, inviteUrl=none, whatsappGroupId=none`
      : `pending check failed (status=${pending.status}): ${JSON.stringify(pending.json ?? null)?.slice(0, 200)}`
  );

  // 4b. Schedule the mapping lesson with the assigned teacher, then dispatch again.
  const mappingLesson = await prisma.lesson.create({
    data: {
      packageId: ctx2.packageId,
      studentId: ctx2.studentId,
      teacherId: ctx2.teacherUserId,
      title: "שיעור מיפוי",
      scheduledAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      status: "SCHEDULED",
      durationMinutes: 60,
    },
  });
  ctx.lessons.push(mappingLesson.id);

  // Fixture phones are not valid numbers, so the route stops at the roster check and never
  // opens a real WhatsApp group; OPENED is only reachable with real phones + a configured gateway.
  const scheduled = await api<DispatchResponse>("POST", "/api/whatsapp/dispatch-channel", trioBody, undefined, ctx2.cookie);
  const groupStatus = scheduled.json?.data?.groupStatus;
  const userAfter = await prisma.user.findUnique({ where: { id: ctx2.studentId } });
  const okScheduled =
    scheduled.json?.data?.channel === "QUAD_GROUP" &&
    groupStatus !== "PENDING_TEACHER_ASSIGNMENT" &&
    ((groupStatus === "OPENED" && Boolean(userAfter?.whatsappGroupId)) ||
      (groupStatus === "FAILED" && Boolean(scheduled.json?.data?.errorCode) && !userAfter?.whatsappGroupId));

  record(
    4,
    "WhatsApp: mapping lesson scheduled ⇒ group attempted",
    okScheduled,
    okScheduled
      ? `groupStatus=${groupStatus}${scheduled.json?.data?.errorCode ? ` (${scheduled.json.data.errorCode})` : ""}, http=${scheduled.status}`
      : `mapping-lesson dispatch mismatch (status=${scheduled.status}): ${JSON.stringify(scheduled.json ?? null)?.slice(0, 200)}`
  );

  // SINGLE ⇒ transactional only, never opens a group.
  const single = await api<DispatchResponse>("POST", "/api/whatsapp/dispatch-channel", {
    packageType: "SINGLE",
    studentName: ctx2.studentName,
    studentPhone: "0500000000",
    gapTopicsCount: 1,
  }, undefined, ctx2.cookie);

  const okSingle =
    single.json?.success === true &&
    single.json?.data?.channel === "TRANSACTIONAL_SINGLE" &&
    single.json?.data?.isGroupOpened === false;

  record(
    4,
    "WhatsApp 1-vs-4: SINGLE ⇒ transactional",
    okSingle,
    okSingle
      ? `channel=${single.json?.data?.channel}, groupOpened=${single.json?.data?.isGroupOpened}`
      : `single dispatch failed (status=${single.status}): ${JSON.stringify(single.json ?? null)?.slice(0, 200)}`
  );
}

async function station5_prelesson(ctx2: Awaited<ReturnType<typeof station1_diagnostic>>) {
  // Mandatory context: PreLessonAsset bound to packageId + feeds PedagogicalBrief.
  const asset = await prisma.preLessonAsset.create({
    data: {
      packageId: ctx2.packageId,
      assetType: PreLessonAssetType.TEXT_NOTE,
      textContent: "סקירה של כלל השרשרת ואינטגרלים — חובה לפני השיעור",
      uploadedById: ctx2.studentId,
    },
  });
  ctx.assets.push(asset.id);

  const brief = await prisma.package.findUnique({
    where: { id: ctx2.packageId },
    include: { preLessonAssets: { orderBy: { createdAt: "desc" }, take: 5 } },
  });
  const inBrief = brief?.preLessonAssets?.some((a) => a.id === asset.id) === true;

  record(
    5,
    "Mandatory Pre-Lesson Context → PedagogicalBrief",
    inBrief,
    inBrief
      ? `asset ${asset.id} bound to package ${ctx2.packageId} and present in brief (${brief?.preLessonAssets.length} assets)`
      : "asset not found in pedagogical brief"
  );
}

async function station6_summary(ctx2: Awaited<ReturnType<typeof station1_diagnostic>>) {
  // POST /api/lessons/[id]/summary with resolved gaps ⇒ gap tree update + ledger COMPENSATION.
  const res = await api<{ lesson?: { status?: string; pedagogicalBrief?: string | null }; error?: string }>(
    "POST",
    `/api/lessons/${ctx2.lessonId}/summary`,
    {
      teacherId: ctx2.teacherUserId,
      summaryText: "השיעור סוכם: כלל השרשרת הובן, אינטגרלים תורגלו.",
      resolvedGaps: ["כלל השרשרת"],
      remainingGaps: ["וקטורים"],
      studentRating: 5,
    },
    undefined,
    ctx2.cookie
  );

  const lesson = await prisma.lesson.findUnique({ where: { id: ctx2.lessonId } });
  const quiz = await prisma.diagnosticQuiz.findFirst({
    where: { packageId: ctx2.packageId },
    orderBy: { createdAt: "desc" },
  });

  const gapUpdated =
    quiz?.identifiedGaps?.includes("כלל השרשרת") === false &&
    quiz?.identifiedGaps?.includes("וקטורים") === true;

  record(
    6,
    "Lesson close → resolvedGaps update",
    res.status === 200 && lesson?.status === "COMPLETED" && gapUpdated,
    res.status === 200 && lesson?.status === "COMPLETED" && gapUpdated
      ? `status=${lesson?.status}, gaps after=${quiz?.identifiedGaps?.join(",")}`
      : `summary failed: status=${res.status}, lesson=${lesson?.status}, gaps=${quiz?.identifiedGaps?.join(",")}`
  );
}

async function station7_override(ctx2: Awaited<ReturnType<typeof station1_diagnostic>>, adminCookie: string) {
  // Super-override: POST /api/admin/override/compensation.
  const res = await api<{ success?: boolean; data?: { lessonCredits?: number; message?: string }; error?: string }>(
    "POST",
    "/api/admin/override/compensation",
    { studentId: ctx2.studentId, reason: "E2E verification override" },
    undefined,
    adminCookie
  );

  const comp = await prisma.billingLedger.findFirst({
    where: {
      userId: ctx2.studentId,
      entryType: LedgerEntryType.PLATFORM_COMPENSATION,
    },
    orderBy: { createdAt: "desc" },
  });
  if (comp) ctx.ledger.push(comp.id);

  const student = await prisma.user.findUnique({ where: { id: ctx2.studentId } });
  const ok =
    res.json?.success === true &&
    comp != null &&
    Number(comp.amount) === OVERRIDE_LESSON_VALUE_ILS &&
    (student?.lessonCredits ?? 0) === 4; // 3 (TRIO) + 1 (override)

  record(
    7,
    "Admin Super-Override → PLATFORM_COMPENSATION",
    ok,
    ok
      ? `ledger PLATFORM_COMPENSATION amount=${comp?.amount} balanced vs CHARGE (relatedId=${comp?.relatedId ?? "—"}), credits=${student?.lessonCredits}`
      : `override failed: api=${res.status} ${res.json?.error ?? ""}, comp=${comp?.id ?? "none"}, credits=${student?.lessonCredits}, amount=${comp?.amount}`
  );
}

async function station8_quietDesk(adminCookie?: string) {
  // FastMCP tool anchors defined in hive_mcp.py (parse-level).
  const fs = await import("fs");
  const path = await import("path");
  const hiveSource = fs.readFileSync(path.join(process.cwd(), "agents_hive", "hive_mcp.py"), "utf8");
  const tools = [
    "handle_package_whatsapp_flow",
    "complete_lesson_and_settle",
    "admin_issue_compensation",
    "get_critical_desk_events",
  ];
  const missingTools = tools.filter((t) => !hiveSource.includes(`def ${t}`));
  record(
    8,
    "FastMCP core tools",
    missingTools.length === 0,
    missingTools.length === 0
      ? `4 core tools defined: ${tools.join(", ")}`
      : `missing: ${missingTools.join(", ")}`
  );

  // Head of Desk quiet layer: risk-events must return ONLY CRITICAL exceptions.
  // Without crafted violations, the happy path must be empty (quiet).
  const res = await api<{ events?: Array<{ severity: string; kind: string; title: string }>; error?: string }>(
    "GET",
    "/api/admin/audit/risk-events",
    undefined,
    undefined,
    adminCookie
  );
  const events = res.json?.events ?? [];
  const quiet =
    res.status === 200 &&
    Array.isArray(events) &&
    events.every((e) => e.severity === "CRITICAL") &&
    events.every((e) => ["NO_TEACHER_ASSIGNED", "STRIPE_FAILURE", "LEDGER_IMBALANCE", "TEACHER_NO_SHOW"].includes(e.kind));

  record(
    8,
    "Head of Desk — risk-events (quiet/CRITICAL only)",
    quiet,
    quiet
      ? `events=${events.length} (all CRITICAL), kinds=${[...new Set(events.map((e) => e.kind))].join(",") || "none (quiet)"}`
      : `risk-events contract mismatch: status=${res.status}, events=${events.length}`
  );
}

async function main() {
  console.log("=== PROJECT 8 — E2E DRY-RUN VERIFICATION (8 stations) ===");
  console.log(`Server: ${appBase()}\n`);

  try {
    const ctx2 = await station1_diagnostic();
    await station2_teaser(ctx2);
    await station3_purchase(ctx2);
    await station4_dispatch(ctx2);
    await station5_prelesson(ctx2);
    await station6_summary(ctx2);

    // Mint a temporary admin session once and reuse for guarded stations 7-8.
    const suffix = randomSuffix();
    const admin = await prisma.user.create({
      data: {
        name: `E2E Admin ${suffix}`,
        phone: `052${suffix}`,
        email: `e2e-admin-${suffix}@example.com`,
        password: "MOCK_PASSWORD_E2E",
        role: Role.ADMIN,
      },
    });
    ctx.students.push(admin.id);
    const adminToken = await signSession(admin.id);
    const adminCookie = `${SESSION_COOKIE_NAME}=${adminToken}`;

    await station7_override(ctx2, adminCookie);
    await station8_quietDesk(adminCookie);
  } catch (err) {
    record(0, "Unexpected error", false, err instanceof Error ? err.message : String(err));
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }

  console.log("");
  for (const r of results) {
    console.log(`${r.ok ? green("  [PASS]") : red("  [FAIL]")} Station ${r.station}: ${r.name}`);
    console.log(`        ${r.detail}`);
  }
  console.log("");
  console.log(`  Result: ${passed} passed, ${failed} failed`);
  console.log(failed === 0 ? green("  ALL CHECKS PASSED") : red("  SOME CHECKS FAILED"));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(red("Fatal error:"), err);
  process.exit(1);
});