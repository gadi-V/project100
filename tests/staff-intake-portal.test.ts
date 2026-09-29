import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseIntakeAssessment } from "../lib/intake-assessment";
import {
  buildIntakePayload,
  EMPTY_INTAKE_FORM,
  PARENT_INTAKE_FIELDS,
  STUDENT_INTAKE_FIELDS,
  type IntakeFormState,
} from "../lib/intake-form";

const readSource = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

const session = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
const navigation = vi.hoisted(() => ({
  redirect: vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  usePathname: vi.fn(() => "/portal/dashboard"),
  useRouter: vi.fn(() => ({ replace: vi.fn(), push: vi.fn() })),
}));
const audit = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));

const db = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userFindFirst: vi.fn(),
  userFindMany: vi.fn(),
  userCount: vi.fn(),
  userCreate: vi.fn(),
  teacherProfileCreate: vi.fn(),
  fallbackLeadFindMany: vi.fn(),
  fallbackLeadFindUnique: vi.fn(),
  fallbackLeadCount: vi.fn(),
  intakeAssessmentFindMany: vi.fn(),
  intakeAssessmentCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("next/navigation", () => navigation);
vi.mock("../lib/session", () => session);
vi.mock("../lib/audit", () => audit);
vi.mock("../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: db.userFindUnique,
      findFirst: db.userFindFirst,
      findMany: db.userFindMany,
      count: db.userCount,
      create: db.userCreate,
    },
    teacherProfile: { create: db.teacherProfileCreate },
    fallbackLead: {
      findMany: db.fallbackLeadFindMany,
      findUnique: db.fallbackLeadFindUnique,
      count: db.fallbackLeadCount,
    },
    intakeAssessment: { findMany: db.intakeAssessmentFindMany, create: db.intakeAssessmentCreate },
    $transaction: db.transaction,
  },
}));

type Role = "STUDENT" | "TEACHER" | "ADMIN" | "MANAGER" | "REPRESENTATIVE";

const sessionUser = (role: Role, id = `user-${role.toLowerCase()}`) => ({
  id,
  name: `משתמש ${role}`,
  role,
  lessonCredits: 0,
  isApproved: true,
});

type ElementLike = { type: unknown; props: { children?: unknown; [key: string]: unknown } };

function asElement(node: unknown): ElementLike {
  return node as ElementLike;
}

async function expectRedirect(run: () => unknown, target: string) {
  await expect(Promise.resolve().then(run)).rejects.toThrow(`NEXT_REDIRECT:${target}`);
  expect(navigation.redirect).toHaveBeenCalledWith(target);
}

const LEAD = { id: "lead-1", name: "נועה כהן", phone: "0501112233", grade: "מתמטיקה", createdAt: new Date("2026-09-20T08:00:00Z") };
const STUDENT = { id: "stu-1", name: "מתן לוי", phone: "0547654321", classTrack: "5 יח״ל", createdAt: new Date("2026-09-25T08:00:00Z") };

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("AUTH_SECRET", "vitest-auth-secret-at-least-32-characters");
  session.getCurrentUser.mockResolvedValue(null);
  db.fallbackLeadFindMany.mockResolvedValue([LEAD]);
  db.fallbackLeadCount.mockResolvedValue(1);
  db.fallbackLeadFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === LEAD.id ? LEAD : where.id === "lead-old" ? { ...LEAD, id: "lead-old", name: "ליד ישן" } : null
  );
  db.userFindMany.mockResolvedValue([STUDENT]);
  db.userCount.mockResolvedValue(1);
  db.userFindFirst.mockResolvedValue(null);
  db.intakeAssessmentFindMany.mockResolvedValue([]);
  db.intakeAssessmentCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "intake-1",
    ...data,
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("public registration is for students and parents only", () => {
  it("the /register hub has no teacher option and points teachers to /careers", () => {
    const src = readSource("app/register/page.tsx");
    expect(src).not.toContain("/register/teacher");
    expect(src).not.toMatch(/מורה \/ מרצה|הרשמת מורה/);
    expect(src).toContain('href="/register/student"');
    expect(src).toContain('href="/careers"');
    expect(src).toContain("הרשמה ל-PROJECT100");
    expect(src).toContain("הגש מועמדות להוראה");
  });

  it("/register/teacher redirects to /careers and no longer renders a sign-up form", async () => {
    const { default: TeacherRegisterPage } = await import("../app/register/teacher/page");
    await expectRedirect(() => TeacherRegisterPage(), "/careers");
    const src = readSource("app/register/teacher/page.tsx");
    expect(src).not.toContain("/api/register");
    expect(src).not.toContain("<form");
  });

  it.each(["TEACHER", "teacher"])("POST /api/register refuses role %s without creating an account", async (role) => {
    const { POST } = await import("../app/api/register/route");
    const res = await POST(
      new Request("https://project100.test/api/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "מורה", phone: "0521234567", password: "secret123", role, subjects: ["מתמטיקה"] }),
      })
    );
    expect(res.status).toBe(403);
    expect(db.userCreate).not.toHaveBeenCalled();
    expect(db.teacherProfileCreate).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("POST /api/register still creates student accounts", async () => {
    db.userFindUnique.mockResolvedValue(null);
    db.userCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "new-1", ...data }));
    const { POST } = await import("../app/api/register/route");
    const res = await POST(
      new Request("https://project100.test/api/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "תלמיד", phone: "0521234567", password: "secret123", role: "STUDENT" }),
      })
    );
    expect(res.status).toBe(201);
    const [args] = db.userCreate.mock.calls[0] as [{ data: { role: string } }];
    expect(args.data.role).toBe("STUDENT");
  });
});

describe("staff portal access control", () => {
  const loadIntake = async () => (await import("../app/portal/intake/page")).default;
  const loadDashboard = async () => (await import("../app/portal/dashboard/page")).default;
  const noParams = () => Promise.resolve({});

  it.each([
    ["anonymous", null],
    ["STUDENT", sessionUser("STUDENT")],
    ["TEACHER", sessionUser("TEACHER")],
  ])("/portal/intake sends %s to the staff gate", async (_label, user) => {
    session.getCurrentUser.mockResolvedValue(user);
    const IntakePage = await loadIntake();
    await expectRedirect(() => IntakePage({ searchParams: noParams() }), "/portal/login");
    expect(db.fallbackLeadFindMany).not.toHaveBeenCalled();
    expect(db.userFindMany).not.toHaveBeenCalled();
  });

  it.each([
    ["anonymous", null],
    ["STUDENT", sessionUser("STUDENT")],
  ])("/portal/dashboard sends %s to the staff gate", async (_label, user) => {
    session.getCurrentUser.mockResolvedValue(user);
    const Dashboard = await loadDashboard();
    await expectRedirect(() => Dashboard(), "/portal/login");
    expect(db.fallbackLeadCount).not.toHaveBeenCalled();
    expect(db.intakeAssessmentFindMany).not.toHaveBeenCalled();
  });

  it("/portal/dashboard keeps teachers on their weekly board in /dashboard", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("TEACHER"));
    const Dashboard = await loadDashboard();
    await expectRedirect(() => Dashboard(), "/dashboard");
  });

  it.each(["REPRESENTATIVE", "ADMIN", "MANAGER"] as const)("/portal/dashboard renders for %s", async (role) => {
    session.getCurrentUser.mockResolvedValue(sessionUser(role));
    const Dashboard = await loadDashboard();
    const tree = asElement(await Dashboard());
    expect(navigation.redirect).not.toHaveBeenCalled();
    const [header] = tree.props.children as ElementLike[];
    expect(header.props.isAdmin).toBe(role !== "REPRESENTATIVE");
  });

  it("counts only leads and new students that have no intake yet", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("REPRESENTATIVE"));
    const Dashboard = await loadDashboard();
    await Dashboard();

    const [leadArgs] = db.fallbackLeadCount.mock.calls[0] as [{ where: Record<string, unknown> }];
    expect(leadArgs.where).toEqual({ isHandled: false, intakeAssessments: { none: {} } });
    const [studentArgs] = db.userCount.mock.calls[0] as [
      { where: { role: string; intakeAssessments: unknown; createdAt: { gte: Date } } },
    ];
    expect(studentArgs.where.role).toBe("STUDENT");
    expect(studentArgs.where.intakeAssessments).toEqual({ none: {} });
    expect(studentArgs.where.createdAt.gte).toBeInstanceOf(Date);
  });

  it("/portal/intake gives a representative the merged queue, newest first", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("REPRESENTATIVE"));
    const IntakePage = await loadIntake();
    const tree = asElement(await IntakePage({ searchParams: noParams() }));
    const [, main] = tree.props.children as ElementLike[];
    const workspace = asElement(main.props.children);

    expect(workspace.props.initialKey).toBeNull();
    expect(workspace.props.candidates).toEqual([
      expect.objectContaining({ kind: "STUDENT", id: "stu-1", name: "מתן לוי", detail: "5 יח״ל" }),
      expect.objectContaining({ kind: "LEAD", id: "lead-1", name: "נועה כהן", detail: "מתמטיקה" }),
    ]);
  });

  it("/portal/intake preselects a deep-linked lead even when it is no longer pending", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("ADMIN"));
    const IntakePage = await loadIntake();
    const tree = asElement(await IntakePage({ searchParams: Promise.resolve({ leadId: "lead-old" }) }));
    const [, main] = tree.props.children as ElementLike[];
    const workspace = asElement(main.props.children);

    expect(workspace.props.initialKey).toBe("LEAD:lead-old");
    expect((workspace.props.candidates as { id: string }[])[0].id).toBe("lead-old");
  });

  it.each([
    ["anonymous", null, 401],
    ["STUDENT", sessionUser("STUDENT"), 403],
    ["TEACHER", sessionUser("TEACHER"), 403],
  ])("intake API rejects %s", async (_label, user, status) => {
    session.getCurrentUser.mockResolvedValue(user);
    const route = await import("../app/api/admin/intake/route");
    const get = await route.GET(new Request("https://project100.test/api/admin/intake?leadId=lead-1"));
    const post = await route.POST(
      new Request("https://project100.test/api/admin/intake", { method: "POST", body: "{}" })
    );
    expect(get.status).toBe(status);
    expect(post.status).toBe(status);
    expect(db.intakeAssessmentCreate).not.toHaveBeenCalled();
  });
});

describe("representative intake form → POST /api/admin/intake", () => {
  const filledForm = (): IntakeFormState => ({
    ...EMPTY_INTAKE_FORM,
    grade: "ט",
    levelUnits: "5 יח״ל",
    hobbies: "מחשבים ולחימה",
    isProfessionalHobby: "yes",
    weeklyHobbyFrequency: "3",
    nextExamDate: "2026-11-15",
    lastExamDate: "2026-09-01",
    lastExamScore: "88",
    strongTopic: "אלגברה",
    weakTopic: "גיאומטריה",
    focusRequest: "  ",
    mathPerception: "מאתגרת",
    classListening: "בהקשבה מלאה",
    pastAssistance: "שיעורים פרטיים",
    pastAssistanceDuration: "מעל שנה",
    mainGoals: "לעלות ל-90",
    firstMonthTarget: "לסגור פערים בגיאומטריה",
    parentMainGoalYear: "ביטחון במבחנים",
    parentTargetScore: "90",
    parentAverageScore: "80",
    motivationLevel: "גבוהה",
    successDefinition: "90 במגן",
    homeStudyTime: "1–3 שעות בשבוע",
    hasQuietSpace: "yes",
    hasWorkingEquipment: "no",
    progressFeltRating: "4",
    parentInvolvementLevel: "5",
    representativeNotes: "משפחה מגויסת",
  });

  it("the form covers exactly the questionnaire fields the API stores", () => {
    const formKeys = [...STUDENT_INTAKE_FIELDS, ...PARENT_INTAKE_FIELDS].map((f) => f.key).sort();
    const parsed = parseIntakeAssessment(buildIntakePayload(filledForm(), { kind: "LEAD", id: "lead-1" }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.keys(parsed.data.fields).sort()).toEqual(formKeys);
    expect(new Set(formKeys).size).toBe(formKeys.length);
  });

  it("marks exactly the fields the API requires", () => {
    for (const field of [...STUDENT_INTAKE_FIELDS, ...PARENT_INTAKE_FIELDS]) {
      const form = { ...filledForm(), [field.key]: "" } as IntakeFormState;
      const parsed = parseIntakeAssessment(buildIntakePayload(form, { kind: "LEAD", id: "lead-1" }));
      expect(parsed.ok, `${field.key} required=${Boolean(field.required)}`).toBe(!field.required);
    }
    const empty = parseIntakeAssessment(buildIntakePayload(EMPTY_INTAKE_FORM, { kind: "LEAD", id: "lead-1" }));
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    const requiredCount = [...STUDENT_INTAKE_FIELDS, ...PARENT_INTAKE_FIELDS].filter((f) => f.required).length;
    expect(empty.errors).toHaveLength(requiredCount);
  });

  it("converts form strings into the typed API payload", () => {
    const payload = buildIntakePayload(filledForm(), { kind: "STUDENT", id: "stu-1" });
    expect(payload).toMatchObject({
      studentId: "stu-1",
      isProfessionalHobby: true,
      hasWorkingEquipment: false,
      weeklyHobbyFrequency: 3,
      lastExamScore: 88,
      progressFeltRating: 4,
      nextExamDate: "2026-11-15",
      focusRequest: null,
      learningDisabilities: null,
    });
    expect(payload).not.toHaveProperty("fallbackLeadId");
  });

  it("leaves bad numbers for the validator instead of silently dropping them", () => {
    const payload = buildIntakePayload({ ...filledForm(), lastExamScore: "abc" }, { kind: "LEAD", id: "lead-1" });
    expect(payload.lastExamScore).toBe("abc");
    expect(parseIntakeAssessment(payload).ok).toBe(false);
  });

  it("a filled form is saved by the intake API for the logged-in representative", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("REPRESENTATIVE", "rep-7"));
    const { POST } = await import("../app/api/admin/intake/route");
    const payload = buildIntakePayload(filledForm(), { kind: "LEAD", id: "lead-1" });

    const res = await POST(
      new Request("https://project100.test/api/admin/intake", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
    );

    expect(res.status).toBe(201);
    const [args] = db.intakeAssessmentCreate.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(args.data).toMatchObject({
      fallbackLeadId: "lead-1",
      studentId: null,
      representativeId: "rep-7",
      grade: "ט",
      isProfessionalHobby: true,
      hasWorkingEquipment: false,
      lastExamScore: 88,
      parentInvolvementLevel: 5,
      focusRequest: null,
    });
    expect(args.data.nextExamDate).toBeInstanceOf(Date);
    expect(audit.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: "rep-7", action: "INTAKE_ASSESSMENT_RECORDED" })
    );
  });
});

describe("staff routing", () => {
  it("sends representatives to the staff dashboard after sign-in and away from /dashboard", async () => {
    const { staffPortalHome } = await import("../lib/auth/staff-roles");
    expect(staffPortalHome("REPRESENTATIVE")).toBe("/portal/dashboard");
    expect(staffPortalHome("TEACHER")).toBe("/dashboard");
    expect(staffPortalHome("MANAGER")).toBe("/admin");
    expect(readSource("app/dashboard/page.tsx")).toMatch(
      /role === "REPRESENTATIVE"\)\s*\{[\s\S]{0,80}router\.replace\("\/portal\/dashboard"\)/
    );
  });

  it("uses relative imports only in the sprint files", () => {
    for (const file of [
      "app/register/page.tsx",
      "app/register/teacher/page.tsx",
      "app/portal/intake/page.tsx",
      "app/portal/intake/IntakeWorkspace.tsx",
      "app/portal/dashboard/page.tsx",
      "app/portal/PortalHeader.tsx",
      "lib/intake-form.ts",
      "lib/intake-queue.ts",
    ]) {
      expect(readSource(file), file).not.toMatch(/from\s+["']@\//);
    }
  });
});
