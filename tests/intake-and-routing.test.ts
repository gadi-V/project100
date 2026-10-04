import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { signSession } from "../lib/auth";
import { parseIntakeAssessment } from "../lib/intake-assessment";
import { isStaffPortalRole, staffPortalHome } from "../lib/auth/staff-roles";

const ROOT = process.cwd();
const readSource = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const cookieJar = vi.hoisted(() => ({ session: undefined as string | undefined }));

const db = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userFindFirst: vi.fn(),
  userFindMany: vi.fn(),
  userUpdate: vi.fn(),
  userCreate: vi.fn(),
  teacherProfileCreate: vi.fn(),
  teacherProfileUpdate: vi.fn(),
  fallbackLeadFindUnique: vi.fn(),
  intakeAssessmentCreate: vi.fn(),
  intakeAssessmentFindMany: vi.fn(),
  auditLogFindFirst: vi.fn(),
  auditLogCreate: vi.fn(),
  diagnosticQuizFindUnique: vi.fn(),
  diagnosticQuizUpdate: vi.fn(),
  teacherReferralFindFirst: vi.fn(),
  teacherReferralCreate: vi.fn(),
}));

const audit = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
const whatsapp = vi.hoisted(() => ({
  sendQuadGroupInvite: vi.fn(),
  createWhatsAppQuadGroup: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "project8_session" && cookieJar.session
        ? { name, value: cookieJar.session }
        : undefined,
  }),
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: db.userFindUnique,
      findFirst: db.userFindFirst,
      findMany: db.userFindMany,
      update: db.userUpdate,
      create: db.userCreate,
    },
    teacherProfile: { create: db.teacherProfileCreate, update: db.teacherProfileUpdate },
    fallbackLead: { findUnique: db.fallbackLeadFindUnique },
    intakeAssessment: { create: db.intakeAssessmentCreate, findMany: db.intakeAssessmentFindMany },
    auditLog: { findFirst: db.auditLogFindFirst, create: db.auditLogCreate },
    diagnosticQuiz: { findUnique: db.diagnosticQuizFindUnique, update: db.diagnosticQuizUpdate },
    teacherReferral: { findFirst: db.teacherReferralFindFirst, create: db.teacherReferralCreate },
  },
}));
vi.mock("../lib/audit", () => audit);
vi.mock("../lib/whatsapp", () => whatsapp);

type TestUser = {
  id: string;
  name: string;
  role: "STUDENT" | "TEACHER" | "ADMIN" | "MANAGER" | "REPRESENTATIVE";
  lessonCredits: number;
  isApproved: boolean;
  phone: string;
  parentPhone: string | null;
  parentName: string | null;
  quadGroupUrl: string | null;
  whatsappGroupId: string | null;
};

const makeUser = (id: string, role: TestUser["role"], extra: Partial<TestUser> = {}): TestUser => ({
  id,
  name: `user ${id}`,
  role,
  lessonCredits: 0,
  isApproved: true,
  phone: "0541234567",
  parentPhone: null,
  parentName: null,
  quadGroupUrl: null,
  whatsappGroupId: null,
  ...extra,
});

let users: Record<string, TestUser> = {};

async function loginAs(user: TestUser) {
  users[user.id] = user;
  cookieJar.session = await signSession(user.id);
}

function jsonRequest(url: string, body: unknown, method = "POST") {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validIntake = () => ({
  studentId: "student-1",
  grade: "ט",
  levelUnits: "5 יח״ל",
  hobbies: "מחשבים ולחימה",
  isProfessionalHobby: true,
  weeklyHobbyFrequency: 3,
  nextExamDate: "2026-11-15",
  lastExamDate: "2026-09-01",
  lastExamScore: 78.5,
  strongTopic: "אלגברה",
  weakTopic: "גיאומטריה",
  focusRequest: "הוכחות",
  mathPerception: "מאתגרת",
  classListening: "בהקשבה מלאה",
  pastAssistance: "שיעורים פרטיים",
  pastAssistanceDuration: "מעל שנה",
  mainGoals: "לעלות ל-90",
  firstMonthTarget: "לסגור את פערי הגיאומטריה",
  studentImportantNotes: "",
  parentMainGoalYear: "ביטחון במבחנים",
  parentTargetScore: 90,
  parentAverageScore: 80,
  motivationLevel: "גבוהה",
  successDefinition: "ציון 90 במגן",
  homeStudyTime: "שעה ביום",
  hasQuietSpace: true,
  hasWorkingEquipment: false,
  siblingsDetails: "אח בן 12",
  learningDisabilities: null,
  emotionalDifficulties: null,
  pastAssistanceExperience: "מורה פרטי בכיתה ח",
  progressFeltRating: 3,
  whatWorkedOrFailed: "חסר מבנה קבוע",
  homeLanguage: "עברית",
  parentInvolvementLevel: 4,
  parentImportantNotes: null,
  representativeNotes: "משפחה מגויסת",
});

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("AUTH_SECRET", "vitest-auth-secret-at-least-32-characters");
  cookieJar.session = undefined;
  users = { "student-1": makeUser("student-1", "STUDENT") };
  db.userFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => users[where.id] ?? null);
  db.fallbackLeadFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === "lead-1" ? { id: "lead-1" } : null
  );
  db.intakeAssessmentCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "intake-1",
    ...data,
  }));
  db.auditLogFindFirst.mockResolvedValue(null);
  db.auditLogCreate.mockResolvedValue({ id: "audit-1" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("parseIntakeAssessment", () => {
  it("accepts the full mapping-call questionnaire and normalizes types", () => {
    const result = parseIntakeAssessment(validIntake());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.studentId).toBe("student-1");
    expect(result.data.fallbackLeadId).toBeNull();
    expect(result.data.fields.grade).toBe("ט");
    expect(result.data.fields.nextExamDate).toBeInstanceOf(Date);
    expect(result.data.fields.studentImportantNotes).toBeNull();
    expect(result.data.fields.hasWorkingEquipment).toBe(false);
  });

  it("requires a student or lead link", () => {
    const { studentId: _omit, ...rest } = validIntake();
    const result = parseIntakeAssessment(rest);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toContain("לתלמיד רשום או לליד");
  });

  it("reports every missing required field and wrong boolean", () => {
    const body: Record<string, unknown> = { ...validIntake(), grade: "  ", weakTopic: undefined };
    body.hasQuietSpace = "yes";
    const result = parseIntakeAssessment(body);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("כיתה"),
        expect.stringContaining("נושא חלש"),
        expect.stringContaining("מרחב למידה שקט"),
      ])
    );
  });

  it("enforces numeric ranges and valid dates", () => {
    const result = parseIntakeAssessment({
      ...validIntake(),
      lastExamScore: 130,
      progressFeltRating: 6,
      parentInvolvementLevel: 2.5,
      nextExamDate: "not-a-date",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(4);
  });

  it("rejects non-object bodies", () => {
    expect(parseIntakeAssessment(null).ok).toBe(false);
    expect(parseIntakeAssessment([validIntake()]).ok).toBe(false);
  });
});

describe("POST /api/admin/intake — access control", () => {
  const load = async () => (await import("../app/api/admin/intake/route")).POST;
  const url = "https://project100.test/api/admin/intake";

  it("rejects a request without a session", async () => {
    const POST = await load();
    const res = await POST(jsonRequest(url, validIntake()));
    expect(res.status).toBe(401);
    expect(db.intakeAssessmentCreate).not.toHaveBeenCalled();
  });

  it.each(["STUDENT", "TEACHER"] as const)("rejects role %s with 403", async (role) => {
    await loginAs(makeUser(`u-${role}`, role));
    const POST = await load();
    const res = await POST(jsonRequest(url, validIntake()));
    expect(res.status).toBe(403);
    expect(db.intakeAssessmentCreate).not.toHaveBeenCalled();
  });

  it("saves for a representative and takes the representative from the session", async () => {
    await loginAs(makeUser("rep-1", "REPRESENTATIVE"));
    const POST = await load();
    const res = await POST(jsonRequest(url, { ...validIntake(), representativeId: "someone-else" }));

    expect(res.status).toBe(201);
    const [args] = db.intakeAssessmentCreate.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(args.data.representativeId).toBe("rep-1");
    expect(args.data.studentId).toBe("student-1");
    expect(args.data.weakTopic).toBe("גיאומטריה");
    expect(audit.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: "rep-1", action: "INTAKE_ASSESSMENT_RECORDED", entityId: "intake-1" })
    );
    expect(await res.json()).toMatchObject({ success: true, data: { id: "intake-1" } });
  });

  it("accepts a lead-only intake for an admin", async () => {
    await loginAs(makeUser("admin-1", "ADMIN"));
    const POST = await load();
    const { studentId: _omit, ...rest } = validIntake();
    const res = await POST(jsonRequest(url, { ...rest, fallbackLeadId: "lead-1" }));
    expect(res.status).toBe(201);
  });

  it("returns 400 with field errors for an invalid questionnaire", async () => {
    await loginAs(makeUser("rep-1", "REPRESENTATIVE"));
    const POST = await load();
    const res = await POST(jsonRequest(url, { ...validIntake(), mainGoals: "" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("המטרות המרכזיות");
    expect(db.intakeAssessmentCreate).not.toHaveBeenCalled();
  });

  it("returns 404 when the target is not a student", async () => {
    await loginAs(makeUser("rep-1", "REPRESENTATIVE"));
    users["teacher-9"] = makeUser("teacher-9", "TEACHER");
    const POST = await load();
    const res = await POST(jsonRequest(url, { ...validIntake(), studentId: "teacher-9" }));
    expect(res.status).toBe(404);
    expect(db.intakeAssessmentCreate).not.toHaveBeenCalled();
  });
});

describe("staff portal login gate", () => {
  const load = async () => (await import("../app/api/login/route")).POST;
  const url = "https://project100.test/api/login";
  const password = "Secret123!";
  const hash = bcrypt.hashSync(password, 4);

  const withAccount = (role: TestUser["role"]) =>
    db.userFindFirst.mockResolvedValue({ ...makeUser(`acct-${role}`, role), password: hash });

  it("maps staff roles to the right home", () => {
    expect(["TEACHER", "REPRESENTATIVE", "ADMIN", "MANAGER"].every(isStaffPortalRole)).toBe(true);
    expect(isStaffPortalRole("STUDENT")).toBe(false);
    expect(isStaffPortalRole(undefined)).toBe(false);
    expect(staffPortalHome("ADMIN")).toBe("/admin");
    expect(staffPortalHome("REPRESENTATIVE")).toBe("/portal/dashboard");
    expect(staffPortalHome("TEACHER")).toBe("/portal/dashboard");
    expect(staffPortalHome("TEACHER", false)).toBe("/dashboard");
  });

  it("refuses a student through the staff portal without issuing a session cookie", async () => {
    withAccount("STUDENT");
    const POST = await load();
    const res = await POST(jsonRequest(url, { identifier: "0541234567", password, portal: "staff" }));
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it.each(["TEACHER", "REPRESENTATIVE", "ADMIN"] as const)("admits %s through the staff portal", async (role) => {
    withAccount(role);
    const POST = await load();
    const res = await POST(jsonRequest(url, { identifier: "0541234567", password, portal: "staff" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("project8_session=");
  });

  it("keeps the regular student login unchanged", async () => {
    withAccount("STUDENT");
    const POST = await load();
    const res = await POST(jsonRequest(url, { identifier: "0541234567", password }));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/careers/apply", () => {
  const load = async () => (await import("../app/api/careers/apply/route")).POST;
  const url = "https://project100.test/api/careers/apply";
  const application = () => ({
    fullName: "רונית לוי",
    phone: "052-765-4321",
    email: "Ronit@Example.com",
    education: "B.Sc מתמטיקה",
    yearsOfExperience: "6",
    teachingFrameworks: ["SCHOOL", "PRIVATE", "BOGUS"],
    previousInstitutions: "תיכון אורט",
    subjects: "מתמטיקה, פיזיקה, מתמטיקה",
    cvUrl: "https://drive.google.com/file/cv",
  });

  it("normalizes the phone to E.164 and stores the application without creating a user", async () => {
    const POST = await load();
    const res = await POST(jsonRequest(url, application()));

    expect(res.status).toBe(201);
    const [args] = db.auditLogCreate.mock.calls[0] as [
      { data: { action: string; entityId: string; actorId: null; metadata: Record<string, unknown> } },
    ];
    expect(args.data.action).toBe("TEACHER_CANDIDATE_APPLIED");
    expect(args.data.entityId).toBe("+972527654321");
    expect(args.data.actorId).toBeNull();
    expect(args.data.metadata).toMatchObject({
      phone: "+972527654321",
      email: "ronit@example.com",
      yearsOfExperience: 6,
      teachingFrameworks: ["SCHOOL", "PRIVATE"],
      subjects: ["מתמטיקה", "פיזיקה"],
      status: "NEW",
    });
    expect(db.userCreate).not.toHaveBeenCalled();
    expect(db.teacherProfileCreate).not.toHaveBeenCalled();
  });

  it("rejects an invalid phone number", async () => {
    const POST = await load();
    const res = await POST(jsonRequest(url, { ...application(), phone: "123" }));
    expect(res.status).toBe(400);
    expect(db.auditLogCreate).not.toHaveBeenCalled();
  });

  it("rejects a non-https CV link", async () => {
    const POST = await load();
    const res = await POST(jsonRequest(url, { ...application(), cvUrl: "javascript:alert(1)" }));
    expect(res.status).toBe(400);
  });

  it("returns the existing application for a repeat submission", async () => {
    db.auditLogFindFirst.mockResolvedValue({ id: "audit-old" });
    const POST = await load();
    const res = await POST(jsonRequest(url, application()));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { applicationId: "audit-old", duplicate: true } });
    expect(db.auditLogCreate).not.toHaveBeenCalled();
  });
});

describe("POST /api/diagnostic/unlock — no invented group links", () => {
  const load = async () => (await import("../app/api/diagnostic/unlock/route")).POST;
  const url = "https://project100.test/api/diagnostic/unlock";

  beforeEach(() => {
    db.diagnosticQuizFindUnique.mockResolvedValue({
      id: "diag-1",
      ageGroup: "תיכון",
      subject: "מתמטיקה",
      challenge: "גיאומטריה",
      topics: [],
    });
    db.diagnosticQuizUpdate.mockResolvedValue({
      id: "diag-1",
      isUnlocked: true,
      unlockedAt: new Date(),
      estimatedScore: 70,
      recommendationSummary: null,
      topics: [],
    });
    db.userFindMany.mockResolvedValue([
      {
        id: "teacher-1",
        name: "רונית",
        teacherProfile: {
          subjects: ["מתמטיקה"],
          ageGroups: ["תיכון"],
          bio: "גיאומטריה",
          profileImageUrl: null,
          referralCount: 0,
          activeStudentsCount: 0,
          lastReferralAt: null,
          topicProficiencies: null,
        },
        availabilities: [],
      },
    ]);
    db.teacherReferralFindFirst.mockResolvedValue(null);
    db.teacherReferralCreate.mockResolvedValue({});
    db.teacherProfileUpdate.mockResolvedValue({});
  });

  it("does not create or store a placeholder link when no group exists", async () => {
    await loginAs(makeUser("stu-1", "STUDENT", { lessonCredits: 3, parentPhone: "0501112233" }));
    const POST = await load();
    const res = await POST(jsonRequest(url, { diagnosticId: "diag-1" }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { quadGroupUrl: string | null; groupStatus: string } };
    expect(body.data.quadGroupUrl).toBeNull();
    expect(body.data.groupStatus).toBe("PENDING_TEACHER_ASSIGNMENT");
    expect(db.userUpdate).not.toHaveBeenCalled();
    expect(whatsapp.sendQuadGroupInvite).not.toHaveBeenCalled();
    expect(whatsapp.createWhatsAppQuadGroup).not.toHaveBeenCalled();
  });

  it("hides a legacy placeholder link that has no live group behind it", async () => {
    await loginAs(
      makeUser("stu-2", "STUDENT", {
        lessonCredits: 3,
        quadGroupUrl: "https://chat.whatsapp.com/mock-quad-stu-2",
      })
    );
    const POST = await load();
    const res = await POST(jsonRequest(url, { diagnosticId: "diag-1" }));
    const body = (await res.json()) as { data: { quadGroupUrl: string | null } };
    expect(body.data.quadGroupUrl).toBeNull();
  });

  it("returns the real invite link once the live group was opened", async () => {
    await loginAs(
      makeUser("stu-3", "STUDENT", {
        lessonCredits: 3,
        whatsappGroupId: "120363025555555555@g.us",
        quadGroupUrl: "https://chat.whatsapp.com/Inv1te",
      })
    );
    const POST = await load();
    const res = await POST(jsonRequest(url, { diagnosticId: "diag-1" }));
    const body = (await res.json()) as { data: { quadGroupUrl: string | null; groupStatus: string } };
    expect(body.data).toMatchObject({ quadGroupUrl: "https://chat.whatsapp.com/Inv1te", groupStatus: "EXISTING" });
    expect(db.userUpdate).not.toHaveBeenCalled();
  });

  it("has no placeholder generator left in the source", () => {
    const src = readSource("app/api/diagnostic/unlock/route.ts");
    expect(src).not.toMatch(/chat\.whatsapp\.com\/\$\{/);
    expect(src).not.toMatch(/quad-\$\{/);
    expect(src).not.toContain("sendQuadGroupInvite");
  });
});

describe("public UI separation", () => {
  const STAFF_ENTRY = /\/portal|\/careers|\/teachers\/|\/register\/teacher|כניסת מורים|כניסת צוות|מועמדות|גיוס מורים/;

  it("keeps staff and teacher-recruitment entries out of the navbar and the home page", () => {
    expect(readSource("components/Navbar.tsx")).not.toMatch(STAFF_ENTRY);
    expect(readSource("app/page.tsx")).not.toMatch(STAFF_ENTRY);
  });

  it("has exactly one discreet careers link, in the footer", () => {
    const footer = readSource("components/Footer.tsx");
    expect(footer.match(/href="\/careers"/g)).toHaveLength(1);
    expect(footer).toContain("הצטרפות לנבחרת ההוראה");
    expect(footer).not.toContain("/portal");
  });

  it("renders the staff gate without the marketing navbar", () => {
    const shell = readSource("components/AppShell.tsx");
    expect(shell).toMatch(/isClassroom \|\| isStaffPortal/);
  });

  it("exposes the careers API publicly behind the API rate limit", () => {
    const middleware = readSource("proxy.ts");
    expect(middleware).toMatch(/API_RATE_LIMITED_ROUTES = new Set\(\[[^\]]*"\/api\/careers\/apply"/);
    expect(middleware).toMatch(/PUBLIC_API_ROUTES = new Set\(\[[\s\S]*?"\/api\/careers\/apply"[\s\S]*?\]\)/);
    expect(middleware).not.toMatch(/"\/api\/admin\/intake"/);
  });

  it("uses relative imports only in the new sprint files", () => {
    const files = [
      "app/portal/login/page.tsx",
      "app/careers/page.tsx",
      "app/api/careers/apply/route.ts",
      "app/api/admin/intake/route.ts",
      "lib/intake-assessment.ts",
      "lib/teacher-candidate.ts",
      "lib/auth/staff-roles.ts",
    ];
    for (const file of files) {
      expect(readSource(file), file).not.toMatch(/from\s+["']@\//);
    }
  });
});
