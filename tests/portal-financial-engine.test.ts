import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const session = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
const store = vi.hoisted(() => ({
  users: [] as Row[],
  payments: [] as Row[],
  ledger: [] as Row[],
  payouts: [] as Row[],
  lessons: [] as Row[],
  audits: [] as Row[],
}));
const calls = vi.hoisted(() => ({ writes: [] as string[], transactions: [] as unknown[] }));

vi.mock("../lib/session", () => session);
vi.mock("../lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("react-hot-toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children?: unknown; [key: string]: unknown }) =>
      h("a", { href, ...rest }, children as never),
  };
});

function matchField(value: unknown, cond: unknown): boolean {
  if (cond === null || typeof cond !== "object" || cond instanceof Date) return (value ?? null) === cond;
  return Object.entries(cond as Row).every(([op, arg]) => {
    if (op === "in") return (arg as unknown[]).includes(value);
    throw new Error(`fake prisma: unsupported operator ${op}`);
  });
}

function matches(record: Row, where: Row | undefined): boolean {
  return Object.entries(where ?? {}).every(([key, cond]) => matchField(record[key], cond));
}

function pick(record: Row, select: Row | undefined): Row {
  if (!select) return record;
  return Object.fromEntries(Object.keys(select).map((key) => [key, record[key]]));
}

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${++sequence}`;

type Args = { where?: Row; select?: Row; data?: Row; orderBy?: Row; take?: number };

function newestFirst(rows: Row[], orderBy: Row | undefined, take: number | undefined): Row[] {
  const sorted = orderBy?.createdAt === "desc"
    ? [...rows].sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())
    : rows;
  return take === undefined ? sorted : sorted.slice(0, take);
}

const client = {
  user: {
    findUnique: vi.fn(async ({ where, select }: Args) => {
      const user = store.users.find((row) => row.id === where?.id);
      return user ? pick(user, select) : null;
    }),
    findFirst: vi.fn(async ({ where, select }: Args) => {
      const user = store.users.find((row) => matches(row, where));
      return user ? pick(user, select) : null;
    }),
    findMany: vi.fn(async ({ where, select }: Args) => store.users.filter((row) => matches(row, where)).map((row) => pick(row, select))),
    update: vi.fn(async ({ where, data, select }: Args) => {
      calls.writes.push("user.update");
      const user = store.users.find((row) => row.id === where?.id) as Row;
      const increment = (data?.lessonCredits as { increment: number }).increment;
      user.lessonCredits = (user.lessonCredits as number) + increment;
      return pick(user, select);
    }),
  },
  payment: {
    create: vi.fn(async ({ data }: Args) => {
      calls.writes.push("payment.create");
      const row = { id: nextId("pay"), createdAt: new Date(), ...data };
      store.payments.push(row);
      return row;
    }),
    findMany: vi.fn(async ({ where, orderBy, take, select }: Args) =>
      newestFirst(store.payments.filter((row) => matches(row, where)), orderBy, take).map((row) => pick(row, select))
    ),
  },
  billingLedger: {
    create: vi.fn(async ({ data, select }: Args) => {
      calls.writes.push("billingLedger.create");
      if (data?.transactionId && store.ledger.some((row) => row.transactionId === data.transactionId)) {
        throw Object.assign(new Error("Unique constraint failed on transactionId"), { code: "P2002" });
      }
      const row = { id: nextId("led"), createdAt: new Date(), relatedId: null, transactionId: null, ...data };
      store.ledger.push(row);
      return pick(row, select);
    }),
    findMany: vi.fn(async ({ where, orderBy, take, select }: Args) =>
      newestFirst(store.ledger.filter((row) => matches(row, where)), orderBy, take).map((row) => pick(row, select))
    ),
  },
  lesson: {
    groupBy: vi.fn(async ({ where }: Args) => {
      const counts = new Map<string, number>();
      for (const lesson of store.lessons.filter((row) => matches(row, where))) {
        counts.set(lesson.teacherId as string, (counts.get(lesson.teacherId as string) ?? 0) + 1);
      }
      return [...counts].map(([teacherId, count]) => ({ teacherId, _count: { _all: count } }));
    }),
  },
  teacherPayout: {
    findMany: vi.fn(async ({ where, select }: Args) =>
      store.payouts
        .filter((row) => matches(row, where))
        .map((row) => {
          const teacher = store.users.find((user) => user.id === row.teacherId) as Row;
          return pick({ ...row, lesson: null, teacher: { ...teacher, teacherProfile: teacher.teacherProfile ?? null } }, select);
        })
    ),
    updateMany: vi.fn(async ({ where, data }: Args) => {
      calls.writes.push("teacherPayout.updateMany");
      const rows = store.payouts.filter((row) => matches(row, where));
      for (const row of rows) Object.assign(row, data);
      return { count: rows.length };
    }),
  },
  auditLog: {
    create: vi.fn(async ({ data }: Args) => {
      calls.writes.push("auditLog.create");
      store.audits.push({ id: nextId("audit"), ...data });
      return data;
    }),
  },
  /** All-or-nothing like Postgres: a throw inside the callback restores the store. */
  $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>, options?: unknown) => {
    calls.transactions.push(options ?? null);
    const snapshot = Object.fromEntries(
      Object.entries(store).map(([key, rows]) => [key, rows.map((row) => ({ ...row }))])
    ) as typeof store;
    try {
      return await fn(client);
    } catch (error) {
      Object.assign(store, snapshot);
      throw error;
    }
  }),
};

vi.mock("../lib/prisma", () => ({
  get prisma() {
    return client;
  },
}));

import { GET as getBilling, POST as postBilling } from "../app/api/portal/students/[id]/billing/route";
import { GET as getPayouts, POST as postPayouts } from "../app/api/admin/payouts/route";
import BillingTab from "../components/portal/student/BillingTab";
import TeacherPayoutsBoard from "../components/admin/TeacherPayoutsBoard";
import { STUDENT_TABS } from "../lib/student-portal-shared";
import { staffPortalHome } from "../lib/auth/staff-roles";
import { loginLandingPath } from "../lib/auth/login-redirect";
import { sumAccruedPayouts } from "../lib/teacher-dashboard-shared";
import { summarizePayoutLedger, type TeacherBalancesSummary } from "../lib/teacher-payouts-shared";
import type { StudentBillingData } from "../lib/student-billing-shared";

const NOW = new Date("2026-10-04T09:00:00.000Z");
const STUDENT_ID = "stu-matan";
const sessionUser = (role: string, id = `user-${role.toLowerCase()}`) => ({
  id,
  name: `משתמש ${role}`,
  role,
  lessonCredits: 0,
  isApproved: true,
});

const teacher = (id: string, name: string): Row => ({
  id,
  name,
  role: "TEACHER",
  phone: "0520000000",
  email: null,
  lessonCredits: 0,
  teacherProfile: { bankName: "לאומי", bankBranch: "800", accountNumber: "12345", accountHolderName: name },
});

const day = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

function seed() {
  sequence = 0;
  store.users = [
    { id: STUDENT_ID, name: "מתן לוי", role: "STUDENT", phone: "0541234567", email: null, lessonCredits: 2 },
    teacher("t-dana", "דנה"),
    teacher("t-omer", "עומר"),
    teacher("t-noam", "נועם"),
  ];
  store.payments = [
    { id: "pay-online", studentId: STUDENT_ID, createdAt: day(30), packageType: "TRIO", amountPaid: 540, creditsAdded: 3, status: "COMPLETED", transactionId: "pi_123" },
  ];
  store.ledger = [
    { id: "led-online", userId: STUDENT_ID, entryType: "CHARGE", amount: 540, transactionId: "pi_123", relatedId: "pay-online", description: "תשלום Stripe: TRIO", createdAt: day(30) },
    { id: "led-d1", userId: "t-dana", entryType: "PAYOUT", amount: 140, transactionId: "lesson-payout-L1", createdAt: day(20) },
    { id: "led-d1-paid", userId: "t-dana", entryType: "PAYOUT", amount: "140.0000", transactionId: "payout-paid-p1-bank-77", createdAt: day(15) },
    { id: "led-d2", userId: "t-dana", entryType: "PAYOUT", amount: { toString: () => "280.0000" }, transactionId: "lesson-payout-L2", createdAt: day(5) },
    { id: "led-d3", userId: "t-dana", entryType: "PAYOUT", amount: 70, transactionId: null, createdAt: day(3) },
    { id: "led-d-penalty", userId: "t-dana", entryType: "PENALTY", amount: 50, transactionId: null, createdAt: day(2) },
    { id: "led-o1", userId: "t-omer", entryType: "PAYOUT", amount: 140, transactionId: "lesson-payout-L3", createdAt: day(12) },
    { id: "led-o1-paid", userId: "t-omer", entryType: "PAYOUT", amount: -140, transactionId: "payout-paid-0b7c", createdAt: day(10) },
    { id: "led-n1", userId: "t-noam", entryType: "PAYOUT", amount: 210, transactionId: "lesson-payout-L4", createdAt: day(1) },
  ];
  store.lessons = [
    { id: "L1", teacherId: "t-dana", status: "COMPLETED" },
    { id: "L2", teacherId: "t-dana", status: "COMPLETED" },
    { id: "L2b", teacherId: "t-dana", status: "COMPLETED" },
    { id: "L-next", teacherId: "t-dana", status: "SCHEDULED" },
    { id: "L3", teacherId: "t-omer", status: "COMPLETED" },
    { id: "L4", teacherId: "t-noam", status: "COMPLETED" },
    { id: "L5", teacherId: "t-noam", status: "COMPLETED" },
  ];
  const payout = (id: string, teacherId: string, amount: number, status: string): Row => ({
    id,
    teacherId,
    amount: { toString: () => amount.toFixed(4) },
    currency: "ILS",
    status,
    periodStart: day(20),
    periodEnd: day(20),
    createdAt: day(20),
    lessonId: null,
  });
  store.payouts = [
    payout("p1", "t-dana", 140, "PAID"),
    payout("p2", "t-dana", 280, "SCHEDULED"),
    payout("p3", "t-dana", 70, "PROCESSING"),
    payout("p4", "t-noam", 210, "SCHEDULED"),
  ];
  store.audits = [];
}

const context = (id = STUDENT_ID) => ({ params: Promise.resolve({ id }) });
const billingUrl = (id = STUDENT_ID) => `https://project100.test/api/portal/students/${id}/billing`;
const postJson = (url: string, body: unknown) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const PAYMENT = { amount: 1000, paymentMethod: "BANK_TRANSFER", creditsToAdd: 5, notes: "אסמכתא 4471", requestId: "req-12345678" };

async function payoutsSummary(): Promise<TeacherBalancesSummary & { payouts: { id: string }[] }> {
  const res = await getPayouts();
  expect(res.status).toBe(200);
  return (await res.json()) as TeacherBalancesSummary & { payouts: { id: string }[] };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  seed();
  calls.writes = [];
  calls.transactions = [];
  session.getCurrentUser.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("POST /api/portal/students/[id]/billing", () => {
  it("records the payment, the CHARGE ledger row, the credits and the audit entry in one transaction", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("REPRESENTATIVE", "rep-1"));
    const res = await postBilling(postJson(billingUrl(), PAYMENT), context());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      success: true,
      lessonCredits: 7,
      payment: { amount: 1000, creditsAdded: 5, methodLabel: "העברה בנקאית", status: "COMPLETED", isManual: true },
    });

    expect(store.users.find((u) => u.id === STUDENT_ID)?.lessonCredits).toBe(7);
    const payment = store.payments.find((p) => p.transactionId === "manual-payment-req-12345678");
    expect(payment).toMatchObject({ studentId: STUDENT_ID, packageType: "MANUAL_BANK_TRANSFER", amountPaid: 1000, creditsAdded: 5, status: "COMPLETED" });

    const ledger = store.ledger.find((row) => row.transactionId === "manual-payment-req-12345678");
    expect(ledger).toMatchObject({ userId: STUDENT_ID, entryType: "CHARGE", amount: 1000, relatedId: payment?.id, currency: "ILS" });
    expect(ledger?.metadata).toMatchObject({ source: "MANUAL_PAYMENT", paymentMethod: "BANK_TRANSFER", creditsAdded: 5, notes: "אסמכתא 4471", recordedById: "rep-1" });
    expect(body.ledgerEntryId).toBe(ledger?.id);

    expect(store.audits).toEqual([
      expect.objectContaining({
        actorId: "rep-1",
        action: "MANUAL_PAYMENT_AND_CREDITS_ADDED",
        entityType: "Payment",
        entityId: payment?.id,
        metadata: expect.objectContaining({ studentId: STUDENT_ID, amount: 1000, creditsAdded: 5, lessonCreditsAfter: 7 }),
      }),
    ]);
    expect(calls.transactions).toHaveLength(1);
    expect(calls.writes).toEqual(["payment.create", "billingLedger.create", "user.update", "auditLog.create"]);
  });

  it("refuses a replayed request with 409 and leaves nothing behind", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("ADMIN"));
    expect((await postBilling(postJson(billingUrl(), PAYMENT), context())).status).toBe(201);
    const replay = await postBilling(postJson(billingUrl(), PAYMENT), context());
    expect(replay.status).toBe(409);
    expect(store.users.find((u) => u.id === STUDENT_ID)?.lessonCredits).toBe(7);
    expect(store.payments.filter((p) => p.transactionId === "manual-payment-req-12345678")).toHaveLength(1);
    expect(store.audits).toHaveLength(1);
  });

  it("validates the input before writing", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("MANAGER"));
    const res = await postBilling(postJson(billingUrl(), { amount: 0, paymentMethod: "PAYPAL", creditsToAdd: -1 }), context());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("סכום");
    expect(body.error).toContain("אמצעי תשלום");
    expect(calls.writes).toEqual([]);
  });

  it("answers 404 for an id that is not a student", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("ADMIN"));
    expect((await postBilling(postJson(billingUrl("t-dana"), PAYMENT), context("t-dana"))).status).toBe(404);
    expect(calls.writes).toEqual([]);
  });
});

describe("GET /api/portal/students/[id]/billing", () => {
  it("returns payments and ledger rows newest first with labels and the lesson balance", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("ADMIN"));
    await postBilling(postJson(billingUrl(), { ...PAYMENT, paymentMethod: "BIT", requestId: "req-bit-0001" }), context());
    const res = await getBilling(new Request(billingUrl()), context());
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: StudentBillingData };
    expect(data.lessonCredits).toBe(7);
    expect(data.totalPaidIls).toBe(1540);
    expect(data.payments.map((p) => [p.amount, p.methodLabel, p.packageLabel])).toEqual([
      [1000, "ביט", "תשלום ידני"],
      [540, "כרטיס אשראי באתר", "חבילת 3 שיעורים"],
    ]);
    expect(data.ledger.map((row) => [row.entryLabel, row.amount])).toEqual([
      ["תשלום", 1000],
      ["תשלום", 540],
    ]);
  });
});

describe("GET /api/admin/payouts", () => {
  it("nets each teacher's PAYOUT rows against PENALTY rows and payout-paid- settlements, positive or negative", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("ADMIN"));
    const summary = await payoutsSummary();
    expect(
      summary.teachers.map((t) => ({
        id: t.teacherId,
        earned: t.earnedAmount,
        penalty: t.penaltyAmount,
        paid: t.paidAmount,
        balance: t.balance,
        lessons: t.completedLessons,
      }))
    ).toEqual([
      { id: "t-dana", earned: 490, penalty: 50, paid: 140, balance: 300, lessons: 3 },
      { id: "t-noam", earned: 210, penalty: 0, paid: 0, balance: 210, lessons: 2 },
      { id: "t-omer", earned: 140, penalty: 0, paid: 140, balance: 0, lessons: 1 },
    ]);
    expect(summary.totalOpenIls).toBe(510);
    expect(summary.teachersWithBalance).toBe(2);
    expect(summary.teachers[0].lastPaidAt).toBe(day(15).toISOString());
    expect(summary.teachers[0].bank).toEqual({ bankName: "לאומי", bankBranch: "800", accountNumber: "12345", accountHolderName: "דנה" });
    expect(summary.payouts.map((p) => p.id)).toEqual(["p2", "p3", "p4"]);
  });

  it("counts settlement rows by absolute value", () => {
    const totals = summarizePayoutLedger([
      { userId: "t", amount: 100, transactionId: "lesson-payout-a", createdAt: NOW },
      { userId: "t", amount: -40, transactionId: "payout-paid-x", createdAt: NOW },
      { userId: "t", amount: 25, transactionId: "payout-paid-legacy", createdAt: NOW },
    ]);
    expect(totals.get("t")).toEqual({ earnedIls: 100, penaltyIls: 0, paidIls: 65, balanceIls: 35, lastPaidAt: NOW });
  });
});

describe("POST /api/admin/payouts", () => {
  it("zeroes the net balance with a negative payout-paid- offset and closes the open payouts", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("MANAGER", "mgr-1"));
    const res = await postPayouts(postJson("https://project100.test/api/admin/payouts", { teacherId: "t-dana", amount: 300 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, teacherId: "t-dana", amountPaid: 300, penaltyAmount: 50, balanceBefore: 300, balanceAfter: 0, payoutsMarkedPaid: 2 });
    expect(body.transactionId).toMatch(/^payout-paid-[0-9a-f-]{36}$/);

    const offset = store.ledger.find((row) => row.transactionId === body.transactionId);
    expect(offset).toMatchObject({ userId: "t-dana", entryType: "PAYOUT", amount: -300 });
    expect(store.payouts.filter((p) => p.teacherId === "t-dana").map((p) => p.status)).toEqual(["PAID", "PAID", "PAID"]);
    expect(store.payouts.find((p) => p.id === "p4")?.status).toBe("SCHEDULED");
    expect(store.audits).toEqual([
      expect.objectContaining({ actorId: "mgr-1", action: "TEACHER_BALANCE_SETTLED", entityId: "t-dana" }),
    ]);
    expect(calls.transactions).toEqual([{ isolationLevel: "Serializable" }]);

    const summary = await payoutsSummary();
    const dana = summary.teachers.find((t) => t.teacherId === "t-dana");
    expect(dana).toMatchObject({ balance: 0, paidAmount: 440, penaltyAmount: 50, earnedAmount: 490 });
    expect(summary.totalOpenIls).toBe(210);
    expect(summary.payouts.map((p) => p.id)).toEqual(["p4"]);

    const danaRows = store.ledger.filter((row) => row.userId === "t-dana" && row.entryType === "PAYOUT") as {
      amount: number;
      transactionId: string | null;
    }[];
    expect(sumAccruedPayouts(danaRows)).toBe(490);
  });

  it("refuses a second settlement and an amount that does not match the open balance", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("ADMIN"));
    const url = "https://project100.test/api/admin/payouts";
    expect((await postPayouts(postJson(url, { teacherId: "t-dana", amount: 300 }))).status).toBe(200);

    const again = await postPayouts(postJson(url, { teacherId: "t-dana", amount: 300 }));
    expect(again.status).toBe(409);
    expect((await again.json()).currentBalance).toBe(0);

    calls.writes = [];
    const mismatch = await postPayouts(postJson(url, { teacherId: "t-noam", amount: 100 }));
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({ success: false, currentBalance: 210 });
    expect(calls.writes).toEqual([]);
  });

  it("validates the body and the teacher", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("ADMIN"));
    const url = "https://project100.test/api/admin/payouts";
    expect((await postPayouts(postJson(url, { teacherId: "t-dana", amount: -5 }))).status).toBe(400);
    expect((await postPayouts(postJson(url, { teacherId: "t-dana", amount: 1.234 }))).status).toBe(400);
    expect((await postPayouts(postJson(url, { teacherId: STUDENT_ID, amount: 10 }))).status).toBe(404);
    expect(calls.writes).toEqual([]);
  });
});

describe("finance access control", () => {
  it("answers 401 without a session", async () => {
    expect((await getBilling(new Request(billingUrl()), context())).status).toBe(401);
    expect((await getPayouts()).status).toBe(401);
  });

  it.each(["TEACHER", "STUDENT"])("blocks %s from student billing (403)", async (role) => {
    session.getCurrentUser.mockResolvedValue(sessionUser(role, role === "STUDENT" ? STUDENT_ID : "t-dana"));
    expect((await getBilling(new Request(billingUrl()), context())).status).toBe(403);
    expect((await postBilling(postJson(billingUrl(), PAYMENT), context())).status).toBe(403);
    expect(calls.writes).toEqual([]);
    expect(store.users.find((u) => u.id === STUDENT_ID)?.lessonCredits).toBe(2);
  });

  it.each(["TEACHER", "STUDENT", "REPRESENTATIVE"])("blocks %s from teacher payouts (403)", async (role) => {
    session.getCurrentUser.mockResolvedValue(sessionUser(role, role === "TEACHER" ? "t-dana" : `user-${role}`));
    expect((await getPayouts()).status).toBe(403);
    const res = await postPayouts(postJson("https://project100.test/api/admin/payouts", { teacherId: "t-dana", amount: 350 }));
    expect(res.status).toBe(403);
    expect(calls.writes).toEqual([]);
  });
});

describe("teacher sign-in routing", () => {
  it("lands approved teachers on /portal/dashboard and keeps onboarding teachers on /dashboard", () => {
    expect(staffPortalHome("TEACHER", true)).toBe("/portal/dashboard");
    expect(staffPortalHome("TEACHER", false)).toBe("/dashboard");
    expect(loginLandingPath({ role: "TEACHER", isApproved: true }, null)).toBe("/portal/dashboard");
    expect(loginLandingPath({ role: "TEACHER", isApproved: true }, "/dashboard")).toBe("/portal/dashboard");
    expect(loginLandingPath({ role: "TEACHER", isApproved: false }, null)).toBe("/dashboard");
  });

  it("keeps deep links and the student landing", () => {
    expect(loginLandingPath({ role: "TEACHER", isApproved: true }, "/lessons/abc")).toBe("/lessons/abc");
    expect(loginLandingPath({ role: "STUDENT" }, null)).toBe("/dashboard");
    expect(loginLandingPath({ role: "STUDENT" }, "//evil.example")).toBe("/dashboard");
    expect(loginLandingPath({ role: "REPRESENTATIVE" }, "/login")).toBe("/portal/dashboard");
  });

  it("wires both login pages and the login API to the approval-aware landing", () => {
    const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
    expect(read("app/login/page.tsx")).toContain("loginLandingPath(");
    expect(read("app/portal/login/page.tsx")).toContain("staffPortalHome(data.user.role, data.user.isApproved");
    expect(read("app/api/login/route.ts")).toContain("isApproved: user.isApproved");
  });
});

describe("finance UI", () => {
  it("adds the כספים tab to the student file", () => {
    expect(STUDENT_TABS[STUDENT_TABS.length - 1]).toEqual({ key: "billing", label: "כספים" });
    expect(readFileSync(path.join(process.cwd(), "components/portal/student/StudentPortalTabs.tsx"), "utf8")).toContain("<BillingTab");
  });

  it("renders the payment history and the top-up button", () => {
    const data: StudentBillingData = {
      lessonCredits: 7,
      totalPaidIls: 1540,
      payments: [
        { id: "pay-1", createdAt: NOW.toISOString(), amount: 1000, methodLabel: "העברה בנקאית", packageLabel: "תשלום ידני", creditsAdded: 5, status: "COMPLETED", statusLabel: "שולם", isManual: true },
      ],
      ledger: [{ id: "led-1", createdAt: NOW.toISOString(), entryType: "CHARGE", entryLabel: "תשלום", amount: 1000, description: "תשלום ידני · העברה בנקאית · 5 שיעורים" }],
    };
    const html = renderToStaticMarkup(createElement(BillingTab, { studentId: STUDENT_ID, canViewBilling: true, initialData: data }));
    expect(html).toContain("+ הזן תשלום והטען חבילה");
    expect(html).toContain("היסטוריית תשלומים");
    expect(html).toContain("העברה בנקאית");
    expect(html).toContain("₪1,000");
    expect(html).toContain("שולם");
    expect(html).toMatch(/data-testid="billing-credits"[^>]*>7</);
  });

  it("shows teachers a notice instead of billing data", () => {
    const html = renderToStaticMarkup(createElement(BillingTab, { studentId: STUDENT_ID, canViewBilling: false }));
    expect(html).toContain("פרטי הכספים זמינים לנציגים ולהנהלה בלבד");
    expect(html).not.toContain("הזן תשלום");
  });

  it("shows a green mark-as-paid button only for teachers with a balance", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("ADMIN"));
    const { teachers, totalOpenIls, teachersWithBalance } = await payoutsSummary();
    const html = renderToStaticMarkup(createElement(TeacherPayoutsBoard, { initialData: { teachers, totalOpenIls, teachersWithBalance } }));
    expect(html.match(/סמן תשלום כבוצע/g)).toHaveLength(2);
    expect(html).toContain("bg-emerald-600");
    expect(html).toContain("שולם במלואו");
    expect(html).toContain("2 מורים ממתינים לתשלום");
    expect(html).toContain("₪510");
  });

  it("uses relative imports only in the sprint files", () => {
    for (const file of [
      "app/api/portal/students/[id]/billing/route.ts",
      "app/api/admin/payouts/route.ts",
      "app/admin/payouts/page.tsx",
      "app/login/page.tsx",
      "components/portal/student/BillingTab.tsx",
      "components/portal/student/ManualPaymentModal.tsx",
      "components/admin/TeacherPayoutsBoard.tsx",
      "lib/student-billing.ts",
      "lib/student-billing-shared.ts",
      "lib/teacher-payouts.ts",
      "lib/teacher-payouts-shared.ts",
      "lib/auth/login-redirect.ts",
    ]) {
      expect(readFileSync(path.join(process.cwd(), file), "utf8"), file).not.toMatch(/from ["']@\//);
    }
    expect(readFileSync(path.join(process.cwd(), "app/api/portal/students/[id]/billing/route.ts"), "utf8")).toContain(
      'from "../../../../../../lib/student-billing"'
    );
  });
});
