import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const session = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
const store = vi.hoisted(() => ({
  users: [] as Row[],
  ledger: [] as Row[],
  payouts: [] as Row[],
  lessons: [] as Row[],
  audits: [] as Row[],
}));
const calls = vi.hoisted(() => ({ writes: [] as string[] }));

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

function matches(record: Row, where: Row | undefined): boolean {
  return Object.entries(where ?? {}).every(([key, cond]) => {
    if (cond === null || typeof cond !== "object") return (record[key] ?? null) === cond;
    return Object.entries(cond as Row).every(([op, arg]) => {
      if (op === "in") return (arg as unknown[]).includes(record[key]);
      throw new Error(`fake prisma: unsupported operator ${op}`);
    });
  });
}

function pick(record: Row, select: Row | undefined): Row {
  if (!select) return record;
  return Object.fromEntries(Object.keys(select).map((key) => [key, record[key]]));
}

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${++sequence}`;

type Args = { where?: Row; select?: Row; data?: Row };

const client = {
  user: {
    findFirst: vi.fn(async ({ where, select }: Args) => {
      const user = store.users.find((row) => matches(row, where));
      return user ? pick(user, select) : null;
    }),
    findMany: vi.fn(async ({ where, select }: Args) => store.users.filter((row) => matches(row, where)).map((row) => pick(row, select))),
  },
  billingLedger: {
    create: vi.fn(async ({ data, select }: Args) => {
      calls.writes.push("billingLedger.create");
      const row = { id: nextId("led"), createdAt: new Date(), transactionId: null, ...data };
      store.ledger.push(row);
      return pick(row, select);
    }),
    findMany: vi.fn(async ({ where, select }: Args) => store.ledger.filter((row) => matches(row, where)).map((row) => pick(row, select))),
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
        .map((row) => pick({ ...row, lesson: null, teacher: store.users.find((user) => user.id === row.teacherId) }, select))
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
  $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(client)),
};

vi.mock("../lib/prisma", () => ({
  get prisma() {
    return client;
  },
}));

import { GET as getPayouts, POST as postPayouts } from "../app/api/admin/payouts/route";
import TeacherPayoutsBoard from "../components/admin/TeacherPayoutsBoard";
import BillingTab from "../components/portal/student/BillingTab";
import { summarizePayoutLedger, type TeacherBalanceRow, type TeacherBalancesSummary } from "../lib/teacher-payouts-shared";
import { nextBatchDate, summarizeSubscription, type StudentBillingData } from "../lib/student-billing-shared";
import { isLegacyBillingTab, STUDENT_TABS, type StandingOrderData } from "../lib/student-portal-shared";
import type { SubscriptionRow } from "../lib/pedagogic-decision";

const NOW = new Date("2026-10-04T09:00:00.000Z");
const URL_PAYOUTS = "https://project100.test/api/admin/payouts";
const day = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

const teacher = (id: string, name: string): Row => ({
  id,
  name,
  role: "TEACHER",
  phone: "0520000000",
  email: null,
  teacherProfile: { bankName: "הפועלים", bankBranch: "600", accountNumber: "5555", accountHolderName: name },
});

const ledger = (userId: string, entryType: string, amount: number, transactionId: string | null, daysAgo: number): Row => ({
  id: nextId("seed"),
  userId,
  entryType,
  amount,
  transactionId,
  createdAt: day(daysAgo),
});

function seed() {
  sequence = 0;
  store.users = [
    teacher("t-avi", "אבי"),
    teacher("t-ben", "בן"),
    teacher("t-gal", "גל"),
    { id: "stu-1", name: "תלמיד", role: "STUDENT", phone: "0540000000", email: null },
  ];
  store.ledger = [
    // אבי: ₪500 earned, ₪100 late-cancel fine written positive by the cancel route.
    ledger("t-avi", "PAYOUT", 300, "lesson-payout-A1", 10),
    ledger("t-avi", "PAYOUT", 200, "lesson-payout-A2", 6),
    ledger("t-avi", "PENALTY", 100, null, 4),
    // בן: ₪140 earned, ₪190 of fines in both signs.
    ledger("t-ben", "PAYOUT", 140, "lesson-payout-B1", 9),
    ledger("t-ben", "PENALTY", 100, null, 8),
    ledger("t-ben", "PENALTY", -90, null, 7),
    // גל: the ₪27 fine was waived after an approved appeal.
    ledger("t-gal", "PAYOUT", 180, "lesson-payout-G1", 5),
    ledger("t-gal", "PENALTY", 27, null, 4),
    ledger("t-gal", "ADJUSTMENT", 27, "appeal-waive-G1", 3),
    // Student rows never reach the payroll.
    ledger("stu-1", "CHARGE", 540, "pi_1", 20),
    ledger("stu-1", "ADJUSTMENT", 50, "manual-adjust-1", 2),
  ];
  store.lessons = [
    { id: "A1", teacherId: "t-avi", status: "COMPLETED" },
    { id: "A2", teacherId: "t-avi", status: "COMPLETED" },
    { id: "B1", teacherId: "t-ben", status: "COMPLETED" },
    { id: "G1", teacherId: "t-gal", status: "COMPLETED" },
  ];
  const payout = (id: string, amount: number, status: string): Row => ({
    id,
    teacherId: "t-avi",
    amount,
    currency: "ILS",
    status,
    periodStart: day(10),
    periodEnd: day(10),
    createdAt: day(10),
    lessonId: null,
  });
  store.payouts = [payout("p-a1", 300, "SCHEDULED"), payout("p-a2", 200, "PROCESSING")];
  store.audits = [];
}

const admin = { id: "admin-1", name: "מנהלת", role: "ADMIN", lessonCredits: 0, isApproved: true };
const postJson = (body: unknown) =>
  new Request(URL_PAYOUTS, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function summary(): Promise<TeacherBalancesSummary> {
  const res = await getPayouts();
  expect(res.status).toBe(200);
  return (await res.json()) as TeacherBalancesSummary;
}

async function row(teacherId: string): Promise<TeacherBalanceRow> {
  const found = (await summary()).teachers.find((t) => t.teacherId === teacherId);
  if (!found) throw new Error(`no payroll row for ${teacherId}`);
  return found;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  seed();
  calls.writes = [];
  session.getCurrentUser.mockResolvedValue(admin);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("teacher payroll: PENALTY offset", () => {
  it("a teacher with ₪500 earned and a ₪100 fine is owed ₪400 net", async () => {
    expect(await row("t-avi")).toMatchObject({ earnedAmount: 500, penaltyAmount: 100, paidAmount: 0, balance: 400, completedLessons: 2 });
  });

  it("marking paid settles exactly the ₪400 net and leaves nothing behind", async () => {
    const gross = await postPayouts(postJson({ teacherId: "t-avi", amount: 500 }));
    expect(gross.status).toBe(409);
    expect(await gross.json()).toMatchObject({ success: false, currentBalance: 400 });
    expect(calls.writes).toEqual([]);

    const res = await postPayouts(postJson({ teacherId: "t-avi", amount: 400 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, amountPaid: 400, penaltyAmount: 100, balanceBefore: 400, balanceAfter: 0, payoutsMarkedPaid: 2 });

    const offset = store.ledger.find((entry) => entry.transactionId === body.transactionId);
    expect(offset).toMatchObject({ userId: "t-avi", entryType: "PAYOUT", amount: -400 });
    expect((offset?.metadata as Row).penaltyAmount).toBe(100);
    expect(store.audits[0]).toMatchObject({ action: "TEACHER_BALANCE_SETTLED", entityId: "t-avi" });
    expect(store.payouts.map((p) => p.status)).toEqual(["PAID", "PAID"]);

    expect(await row("t-avi")).toMatchObject({ earnedAmount: 500, penaltyAmount: 100, paidAmount: 400, balance: 0 });
    const again = await postPayouts(postJson({ teacherId: "t-avi", amount: 400 }));
    expect(again.status).toBe(409);
    expect((await again.json()).currentBalance).toBe(0);

    // The settled fine is not deducted a second time from the next lesson.
    store.ledger.push(ledger("t-avi", "PAYOUT", 140, "lesson-payout-A3", 0));
    expect(await row("t-avi")).toMatchObject({ earnedAmount: 640, penaltyAmount: 100, paidAmount: 400, balance: 140 });
  });

  it("fines larger than the pay leave a ₪0 balance, never a negative one", async () => {
    expect(await row("t-ben")).toMatchObject({ earnedAmount: 140, penaltyAmount: 190, paidAmount: 0, balance: 0 });
    const res = await postPayouts(postJson({ teacherId: "t-ben", amount: 140 }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ success: false, currentBalance: 0 });
    expect(calls.writes).toEqual([]);
  });

  it("does not deduct a fine waived after an approved appeal", async () => {
    expect(await row("t-gal")).toMatchObject({ earnedAmount: 180, penaltyAmount: 0, balance: 180 });
  });

  it("totals only the net balances and keeps students out of the payroll", async () => {
    const data = await summary();
    expect(data.teachers.map((t) => [t.teacherId, t.balance])).toEqual([
      ["t-avi", 400],
      ["t-gal", 180],
      ["t-ben", 0],
    ]);
    expect(data.totalOpenIls).toBe(580);
    expect(data.teachersWithBalance).toBe(2);
  });

  it("summarizePayoutLedger counts fines by absolute value and ignores unrelated adjustments", () => {
    const totals = summarizePayoutLedger([
      { userId: "t", entryType: "PAYOUT", amount: "500.0000", transactionId: "lesson-payout-1", createdAt: NOW },
      { userId: "t", entryType: "PENALTY", amount: -60, transactionId: null, createdAt: NOW },
      { userId: "t", entryType: "PENALTY", amount: { toString: () => "40.0000" }, transactionId: null, createdAt: NOW },
      { userId: "t", entryType: "ADJUSTMENT", amount: 999, transactionId: "manual-fix", createdAt: NOW },
      { userId: "t", entryType: "PAYOUT", amount: -150, transactionId: "payout-paid-x", createdAt: NOW },
    ]);
    expect(totals.get("t")).toEqual({ earnedIls: 500, penaltyIls: 100, paidIls: 150, balanceIls: 250, lastPaidAt: NOW });
  });

  it("the payroll board shows the fines column and pays only the net balance", async () => {
    const html = renderToStaticMarkup(createElement(TeacherPayoutsBoard, { initialData: await summary() }));
    expect(html).toContain("קנסות/קיזוזים (₪)");
    expect(html).toMatch(/data-teacher-id="t-avi"[\s\S]*?data-penalty="100"[\s\S]*?−₪100[\s\S]*?data-balance="400"/);
    expect(html.match(/סמן תשלום כבוצע/g)).toHaveLength(2);
    expect(html).toContain("קוזז בקנסות");
    expect(html).toContain("₪580");
  });
});

const PLAN: SubscriptionRow = {
  id: "log-plan",
  decidedAt: "2026-09-01T10:00:00.000Z",
  subscriptionType: "TWICE_WEEKLY",
  teacherId: "t-avi",
  teacherName: "אבי",
  subject: "מתמטיקה",
  slots: [
    { weekday: 0, time: "17:00" },
    { weekday: 3, time: "17:00" },
  ],
  startDate: "2026-09-07",
  extraPrivateLessons: 0,
  lessonsCreated: 8,
};

const standing = (overrides: Partial<StandingOrderData> = {}): StandingOrderData => ({
  status: "ACTIVE",
  lessonCredits: 7,
  card: { state: "FOUND", brand: "visa", last4: "4242" },
  charges: [],
  ...overrides,
});

const BILLING: StudentBillingData = {
  lessonCredits: 7,
  totalPaidIls: 1540,
  payments: [
    { id: "pay-1", createdAt: NOW.toISOString(), amount: 1000, methodLabel: "העברה בנקאית", packageLabel: "תשלום ידני", creditsAdded: 5, status: "COMPLETED", statusLabel: "שולם", isManual: true },
  ],
  ledger: [{ id: "led-1", createdAt: NOW.toISOString(), entryType: "CHARGE", entryLabel: "תשלום", amount: 1000, description: "תשלום ידני" }],
};

describe("student file: one כספים tab", () => {
  it("keeps five tabs and drops הוראות קבע", () => {
    expect(STUDENT_TABS.map((t) => t.key)).toEqual(["profile", "meetings", "communication", "courses", "billing"]);
    expect(STUDENT_TABS.map((t) => t.label)).toEqual(["סקירה כללית", "מפגשים", "תקשורת", "קורסים", "כספים"]);
    expect(STUDENT_TABS.map((t): string => t.label)).not.toContain("הוראות קבע");
  });

  it("treats the old standing-order tab keys as כספים", () => {
    for (const key of ["standing-orders", "subscriptions", "recurring"]) expect(isLegacyBillingTab(key)).toBe(true);
    for (const key of ["billing", "profile", undefined, ""]) expect(isLegacyBillingTab(key)).toBe(false);
  });

  it("summarizes the weekly plan, the next charge and the standing order", () => {
    expect(summarizeSubscription(standing(), [PLAN], NOW)).toEqual({
      planLabel: "דו שבועי",
      subject: "מתמטיקה",
      teacherName: "אבי",
      nextChargeDate: "2026-10-05",
      recurringStatus: "ACTIVE",
      cardLabel: "VISA •••• 4242",
    });
    expect(summarizeSubscription(standing({ card: { state: "NO_STRIPE_PAYMENT" } }), [PLAN], NOW)).toMatchObject({
      recurringStatus: "PENDING",
      cardLabel: "אין כרטיס מקושר",
    });
    expect(summarizeSubscription(standing({ status: "CANCELLED" }), [PLAN], NOW)).toMatchObject({
      recurringStatus: "CANCELLED",
      nextChargeDate: null,
    });
    expect(summarizeSubscription(standing(), [], NOW)).toMatchObject({
      planLabel: "ללא מנוי שבועי",
      nextChargeDate: null,
      recurringStatus: "NOT_SET",
    });
  });

  it("finds the next four-week batch boundary in Israel time", () => {
    expect(nextBatchDate("2026-09-06", NOW)).toBe("2026-10-04");
    expect(nextBatchDate("2026-09-07", NOW)).toBe("2026-10-05");
    expect(nextBatchDate("2026-10-20", NOW)).toBe("2026-10-20");
    expect(nextBatchDate("2026-10-04", new Date("2026-10-03T21:30:00Z"))).toBe("2026-10-04");
  });

  it("renders the subscription header above the credits, payments and ledger", () => {
    const html = renderToStaticMarkup(
      createElement(BillingTab, { studentId: "stu-1", canViewBilling: true, initialData: BILLING, standingOrders: standing(), subscriptions: [PLAN] })
    );
    expect(html).toContain("מנוי פעיל והוראות קבע");
    expect(html).toMatch(/data-testid="billing-plan"[^>]*>דו שבועי</);
    expect(html).toMatch(/data-testid="billing-next-charge"[^>]*>05\.10\.2026</);
    expect(html).toMatch(/data-testid="billing-recurring-status"[^>]*>פעיל</);
    expect(html).toContain("VISA •••• 4242");
    expect(html).toMatch(/data-testid="billing-credits"[^>]*>7</);
    expect(html).toContain("₪1,540");
    expect(html).toContain("+ הזן תשלום והטען חבילה");
    expect(html).toContain("היסטוריית תשלומים");
    expect(html).toContain("ספר חשבונות");
    expect(html.indexOf("מנוי פעיל והוראות קבע")).toBeLessThan(html.indexOf('data-testid="billing-credits"'));
    expect(html.indexOf('data-testid="billing-credits"')).toBeLessThan(html.indexOf("היסטוריית תשלומים"));
  });

  it("shows a student without a weekly plan as not set", () => {
    const html = renderToStaticMarkup(createElement(BillingTab, { studentId: "stu-1", canViewBilling: true, initialData: BILLING }));
    expect(html).toMatch(/data-testid="billing-plan"[^>]*>ללא מנוי שבועי</);
    expect(html).toMatch(/data-testid="billing-recurring-status"[^>]*>לא הוגדר</);
  });

  it("wires the tab screen to the unified billing tab only", () => {
    const tabs = readFileSync(path.join(process.cwd(), "components/portal/student/StudentPortalTabs.tsx"), "utf8");
    expect(tabs).not.toContain("StandingOrdersTab");
    expect(tabs).toContain("standingOrders={data.standingOrders}");
    expect(tabs).toContain("subscriptions={data.plans.subscriptions}");
    expect(existsSync(path.join(process.cwd(), "components/portal/student/StandingOrdersTab.tsx"))).toBe(false);
  });

  it("uses relative imports only in the sprint files", () => {
    for (const file of [
      "app/api/admin/payouts/route.ts",
      "app/admin/payouts/page.tsx",
      "app/portal/students/[id]/page.tsx",
      "components/admin/TeacherPayoutsBoard.tsx",
      "components/portal/student/BillingTab.tsx",
      "components/portal/student/StudentPortalTabs.tsx",
      "lib/teacher-payouts.ts",
      "lib/teacher-payouts-shared.ts",
      "lib/student-billing-shared.ts",
      "lib/student-portal-shared.ts",
      "scripts/verify-closed-loop-e2e.ts",
    ]) {
      expect(readFileSync(path.join(process.cwd(), file), "utf8"), file).not.toMatch(/from ["']@\//);
    }
  });
});
