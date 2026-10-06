import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMMUNICATION_TEMPLATES,
  parseCommunicationInput,
  parseTemplateContent,
  renderCommunicationTemplate,
  setTemplateFieldValue,
} from "../lib/communication-templates";
import { ageFromBirthDate, parseStudentStatuses, STUDENT_TABS } from "../lib/student-portal-shared";

const session = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
const audit = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
const navigation = vi.hoisted(() => ({
  redirect: vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  usePathname: vi.fn(() => "/portal/students/stu-1"),
  useRouter: vi.fn(() => ({ replace: vi.fn(), push: vi.fn() })),
}));

const db = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  lessonFindFirst: vi.fn(),
  lessonFindMany: vi.fn(),
  lessonFindUnique: vi.fn(),
  lessonUpdate: vi.fn(),
  referralFindFirst: vi.fn(),
  intakeFindMany: vi.fn(),
  logFindMany: vi.fn(),
  logCreate: vi.fn(),
  paymentFindMany: vi.fn(),
  profileUpsert: vi.fn(),
}));

vi.mock("next/navigation", () => navigation);
vi.mock("../lib/session", () => session);
vi.mock("../lib/audit", () => audit);
vi.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUnique: db.userFindUnique },
    lesson: {
      findFirst: db.lessonFindFirst,
      findMany: db.lessonFindMany,
      findUnique: db.lessonFindUnique,
      update: db.lessonUpdate,
    },
    teacherReferral: { findFirst: db.referralFindFirst },
    intakeAssessment: { findMany: db.intakeFindMany },
    studentCommunicationLog: { findMany: db.logFindMany, create: db.logCreate },
    payment: { findMany: db.paymentFindMany },
    studentProfile: { upsert: db.profileUpsert },
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

const NOW = new Date("2026-09-29T12:00:00Z");
const STUDENT_ID = "stu-1";
const TEACHER_ID = "user-teacher";

const STUDENT_ROW = {
  id: STUDENT_ID,
  name: "מתן לוי",
  phone: "054-765-4321",
  email: "matan@example.com",
  role: "STUDENT",
  schoolName: "אורט רחובות",
  classTrack: "5 יח״ל",
  parentName: "רונית לוי",
  parentPhone: "0521112233",
  lessonCredits: 2,
  createdAt: new Date("2026-09-01T08:00:00Z"),
  studentProfile: {
    id: "sp-1",
    userId: STUDENT_ID,
    firstName: "מתן",
    lastName: "לוי",
    grade: "י",
    studyGroup: "5 יח״ל",
    nationalId: "123456789",
    city: "רחובות",
    birthDate: new Date("2010-03-15T00:00:00Z"),
    invoiceName: "רונית לוי",
    invoiceTaxId: "987654321",
    studentStatus: ["STUDENT", "FLOWING_160"],
    statusUpdatedAt: new Date("2026-09-20T10:00:00Z"),
    statusUpdatedById: "user-representative",
    createdAt: new Date("2026-09-01T08:00:00Z"),
    updatedAt: new Date("2026-09-20T10:00:00Z"),
  },
};

const lesson = (overrides: Record<string, unknown>) => ({
  id: "lesson",
  title: "מתמטיקה",
  scheduledAt: NOW,
  startTime: null,
  endTime: null,
  durationMinutes: 60,
  status: "SCHEDULED",
  teacherId: TEACHER_ID,
  packageId: "pkg-trio",
  attendanceStatus: null,
  teacher: { name: "גדי המורה" },
  package: { name: "חבילת 3 שיעורים", credits: 3 },
  ...overrides,
});

const LESSONS = [
  lesson({ id: "l-future", scheduledAt: new Date("2026-10-06T14:00:00Z") }),
  lesson({ id: "l-past", scheduledAt: new Date("2026-09-22T14:00:00Z"), status: "COMPLETED", attendanceStatus: "PRESENT" }),
  lesson({ id: "l-cancelled", scheduledAt: new Date("2026-09-15T14:00:00Z"), status: "CANCELLED" }),
  lesson({
    id: "l-physics",
    title: "פיזיקה",
    scheduledAt: new Date("2026-09-10T15:00:00Z"),
    status: "COMPLETED",
    teacherId: "teacher-2",
    packageId: null,
    teacher: { name: "דנה" },
    package: null,
  }),
];

const LESSON_SUMMARY = [
  "* עבדנו על: משוואות ריבועיות ונוסחת השורשים",
  "* כשיעורי בית: תרגילים 1-10 בעמוד 45",
  "* שיעור הבא: פרבולות",
].join("\n");

const MAPPING_SUMMARY = [
  "כיתה והקבצה: י׳ · 5 יח״ל",
  'ציון אחרון בביה"ס (0-100): 72',
  "למידה בכיתה בביה״ס: בינונית",
  "למידה בבית: רק לפני מבחן",
  "מוטיבציה: גבוהה",
  "חיבור אישי: גבוה",
  "דירוג הנושאים (נושא וציון):",
  "1. אלגברה - 85",
  "2. גיאומטריה - 60",
  "3. הסתברות 55",
  "4. טריגונומטריה",
  "מטרה מרכזית: לעלות ל-90 בבגרות",
  "התאמה לפורמט: ש.פ במקביל",
  "המלצה למנוי: דו שבועי",
  "הערות נוספות: צריך חיזוק בביטחון",
].join("\n");

const POST_MAPPING_CALL = [
  "רקע: תלמיד כיתה י׳, עבר מבית ספר אחר השנה",
  "דגשים אישיים: מתבייש לשאול שאלות בכיתה",
  "דגשים לימודיים: פערים באלגברה מכיתה ט׳",
  "מטרה מרכזית: יציבות מעל 80",
  "סוג הורה: מעורב",
  "סוג המנוי: חד שבועי",
  "מעורבות מנהל מקצועי: שיחת מעקב אחרי חודש",
  "ימים ושעות: ב׳ 17:00, ה׳ 18:00",
  "תוספת ש.פ: 1",
].join("\n");

function jsonRequest(url: string, method: string, body: unknown) {
  return new Request(`https://project100.test${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const routeContext = (id = STUDENT_ID) => ({ params: Promise.resolve({ id }) });

async function postCommunication(body: unknown, id = STUDENT_ID) {
  const { POST } = await import("../app/api/portal/students/[id]/communication/route");
  return POST(jsonRequest(`/api/portal/students/${id}/communication`, "POST", body), routeContext(id));
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("AUTH_SECRET", "vitest-auth-secret-at-least-32-characters");
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  session.getCurrentUser.mockResolvedValue(null);
  db.userFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === STUDENT_ID ? STUDENT_ROW : where.id === "teacher-x" ? { id: "teacher-x", name: "מורה", role: "TEACHER" } : null
  );
  db.lessonFindFirst.mockImplementation(async ({ where }: { where: { teacherId: string } }) =>
    where.teacherId === TEACHER_ID ? { id: "l-past" } : null
  );
  db.referralFindFirst.mockResolvedValue(null);
  db.lessonFindMany.mockResolvedValue(LESSONS);
  db.intakeFindMany.mockResolvedValue([
    {
      id: "intake-1",
      createdAt: new Date("2026-09-05T09:00:00Z"),
      grade: "י",
      levelUnits: "5 יח״ל",
      weakTopic: "אלגברה",
      representative: { name: "שירה הנציגה" },
    },
  ]);
  db.logFindMany.mockResolvedValue([]);
  db.logCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "log-1",
    createdAt: NOW,
    ...data,
  }));
  db.paymentFindMany.mockResolvedValue([
    {
      id: "pay-1",
      createdAt: new Date("2026-09-02T08:00:00Z"),
      packageType: "TRIO",
      amountPaid: 540,
      creditsAdded: 3,
      status: "COMPLETED",
      transactionId: "pi_123",
    },
  ]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("summary templates", () => {
  it("renders the three templates with every line from the spec", () => {
    const postCall = renderCommunicationTemplate("POST_MAPPING_CALL");
    for (const label of ["רקע:", "דגשים אישיים:", "דגשים לימודיים:", "מטרה מרכזית:", "סוג הורה:", "סוג המנוי:", "מעורבות מנהל מקצועי:", "ימים ושעות:", "תוספת ש.פ:"]) {
      expect(postCall).toContain(label);
    }

    expect(renderCommunicationTemplate("LESSON_SUMMARY").split("\n")).toEqual([
      "* עבדנו על: ",
      "* כשיעורי בית: ",
      "* שיעור הבא: ",
    ]);

    const mapping = renderCommunicationTemplate("MAPPING_SUMMARY");
    for (const label of ["כיתה והקבצה:", "ציון אחרון בביה״ס (0-100):", "למידה בכיתה בביה״ס:", "למידה בבית:", "מוטיבציה:", "חיבור אישי:", "דירוג הנושאים (נושא וציון):", "מטרה מרכזית:", "התאמה לפורמט:", "המלצה למנוי:", "הערות נוספות:"]) {
      expect(mapping).toContain(label);
    }
    expect(mapping).toMatch(/\n1\. \n2\. \n3\. \n4\. \n/);
    expect(renderCommunicationTemplate("GENERAL")).toBe("");
  });

  it("offers exactly the choice lists from the spec", () => {
    const choices = (type: keyof typeof COMMUNICATION_TEMPLATES, key: string) =>
      COMMUNICATION_TEMPLATES[type].fields.find((f) => f.key === key)?.options;
    expect(choices("POST_MAPPING_CALL", "parentType")).toEqual(["אדיש", "מעורב", "מתערב"]);
    expect(choices("POST_MAPPING_CALL", "subscriptionType")).toEqual(["חד שבועי", "דו שבועי"]);
    expect(choices("POST_MAPPING_CALL", "extraPrivateLessons")).toEqual(["1", "2", "אין"]);
    expect(choices("MAPPING_SUMMARY", "homeLearning")).toEqual(["גבוהה", "בינונית", "נמוכה", "בכלל לא", "רק לפני מבחן"]);
    expect(choices("MAPPING_SUMMARY", "personalConnection")).toEqual(["גבוה", "בינוני", "נמוך"]);
    expect(choices("MAPPING_SUMMARY", "formatFit")).toEqual(["מתאים", "ש.פ במקביל", "ש.פ לפני", "2 ש.פ לפני", "לא מתאים"]);
  });

  it("quick-choice buttons fill the matching line of the loaded template", () => {
    let text = renderCommunicationTemplate("POST_MAPPING_CALL");
    text = setTemplateFieldValue(text, "POST_MAPPING_CALL", "parentType", "מתערב");
    text = setTemplateFieldValue(text, "POST_MAPPING_CALL", "parentType", "אדיש");
    expect(text).toContain("סוג הורה: אדיש");
    expect(text.match(/סוג הורה:/g)).toHaveLength(1);
  });

  it("rejects an unknown choice, an out-of-range score and missing required lines", () => {
    const result = parseTemplateContent(
      "MAPPING_SUMMARY",
      MAPPING_SUMMARY.replace("מוטיבציה: גבוהה", "מוטיבציה: מעולה")
        .replace("(0-100): 72", "(0-100): 140")
        .replace("מטרה מרכזית: לעלות ל-90 בבגרות", "מטרה מרכזית: ")
    );
    expect(result?.ok).toBe(false);
    const errors = result && !result.ok ? result.errors : [];
    expect(errors.some((e) => e.startsWith("מוטיבציה"))).toBe(true);
    expect(errors.some((e) => e.includes("0 ל-100"))).toBe(true);
    expect(errors).toContain("חסר: מטרה מרכזית");

    expect(parseCommunicationInput({ type: "LESSON_SUMMARY", content: renderCommunicationTemplate("LESSON_SUMMARY") }).ok).toBe(false);
    expect(parseCommunicationInput({ type: "SOMETHING", content: "x" }).ok).toBe(false);
    expect(parseCommunicationInput({ type: "GENERAL", content: "   " }).ok).toBe(false);
  });
});

describe("POST /api/portal/students/[id]/communication", () => {
  it("saves a regular lesson summary written by the student's teacher", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("TEACHER", TEACHER_ID));
    const res = await postCommunication({
      type: "LESSON_SUMMARY",
      content: LESSON_SUMMARY,
      courseContext: "חבילת 3 שיעורים",
      authorId: "spoofed",
      authorName: "מישהו אחר",
    });

    expect(res.status).toBe(201);
    const { data } = db.logCreate.mock.calls[0][0];
    expect(data).toMatchObject({
      studentId: STUDENT_ID,
      authorId: TEACHER_ID,
      authorName: "משתמש TEACHER",
      authorRole: "TEACHER",
      type: "LESSON_SUMMARY",
      courseContext: "חבילת 3 שיעורים",
      content: LESSON_SUMMARY,
    });
    expect(data.structuredData).toEqual({
      template: "LESSON_SUMMARY",
      fields: {
        workedOn: "משוואות ריבועיות ונוסחת השורשים",
        homework: "תרגילים 1-10 בעמוד 45",
        nextLesson: "פרבולות",
      },
    });
    expect(audit.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "STUDENT_COMMUNICATION_LOGGED",
        actorId: TEACHER_ID,
        entityType: "StudentCommunicationLog",
        entityId: "log-1",
        metadata: expect.objectContaining({ studentId: STUDENT_ID, type: "LESSON_SUMMARY" }),
      })
    );
  });

  it("saves a full mapping summary with every structured field", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("TEACHER", TEACHER_ID));
    const res = await postCommunication({
      type: "MAPPING_SUMMARY",
      content: MAPPING_SUMMARY,
      courseContext: "שיעור מיפוי ראשוני - גדי",
    });

    expect(res.status).toBe(201);
    const { data } = db.logCreate.mock.calls[0][0];
    expect(data.type).toBe("MAPPING_SUMMARY");
    expect(data.structuredData).toEqual({
      template: "MAPPING_SUMMARY",
      fields: {
        gradeAndGroup: "י׳ · 5 יח״ל",
        lastSchoolScore: 72,
        classLearning: "בינונית",
        homeLearning: "רק לפני מבחן",
        motivation: "גבוהה",
        personalConnection: "גבוה",
        topicRanking: [
          { rank: 1, topic: "אלגברה", score: 85 },
          { rank: 2, topic: "גיאומטריה", score: 60 },
          { rank: 3, topic: "הסתברות", score: 55 },
          { rank: 4, topic: "טריגונומטריה", score: null },
        ],
        mainGoal: "לעלות ל-90 בבגרות",
        formatFit: "ש.פ במקביל",
        subscriptionRecommendation: "דו שבועי",
        additionalNotes: "צריך חיזוק בביטחון",
      },
    });
  });

  it.each([
    ["REPRESENTATIVE", "REPRESENTATIVE"],
    ["MANAGER", "PEDAGOGIC_MANAGER"],
  ] as const)("saves a post-mapping call summary by %s", async (role, storedRole) => {
    session.getCurrentUser.mockResolvedValue(sessionUser(role));
    const res = await postCommunication({ type: "POST_MAPPING_CALL", content: POST_MAPPING_CALL });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.authorRole).toBe(storedRole);
    const { data } = db.logCreate.mock.calls[0][0];
    expect(data.authorRole).toBe(storedRole);
    expect(data.structuredData.fields).toMatchObject({
      background: "תלמיד כיתה י׳, עבר מבית ספר אחר השנה",
      mainGoal: "יציבות מעל 80",
      parentType: "מעורב",
      subscriptionType: "חד שבועי",
      schedule: "ב׳ 17:00, ה׳ 18:00",
      extraPrivateLessons: "1",
    });
    expect(audit.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "STUDENT_COMMUNICATION_LOGGED" })
    );
  });

  it("blocks students and anonymous callers from writing summaries", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("STUDENT", STUDENT_ID));
    expect((await postCommunication({ type: "GENERAL", content: "שלום" })).status).toBe(403);

    session.getCurrentUser.mockResolvedValue(null);
    expect((await postCommunication({ type: "GENERAL", content: "שלום" })).status).toBe(401);

    expect(db.logCreate).not.toHaveBeenCalled();
    expect(audit.writeAuditLog).not.toHaveBeenCalled();
  });

  it("blocks a teacher who does not teach the student, and summary types outside the role", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("TEACHER", "teacher-stranger"));
    expect((await postCommunication({ type: "LESSON_SUMMARY", content: LESSON_SUMMARY })).status).toBe(403);

    session.getCurrentUser.mockResolvedValue(sessionUser("TEACHER", TEACHER_ID));
    expect((await postCommunication({ type: "POST_MAPPING_CALL", content: POST_MAPPING_CALL })).status).toBe(403);

    session.getCurrentUser.mockResolvedValue(sessionUser("REPRESENTATIVE"));
    expect((await postCommunication({ type: "LESSON_SUMMARY", content: LESSON_SUMMARY })).status).toBe(403);

    expect(db.logCreate).not.toHaveBeenCalled();
  });

  it("returns 404 for a user that is not a student and 400 for an invalid template", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("ADMIN"));
    expect((await postCommunication({ type: "GENERAL", content: "שלום" }, "teacher-x")).status).toBe(404);

    const res = await postCommunication({
      type: "POST_MAPPING_CALL",
      content: POST_MAPPING_CALL.replace("סוג הורה: מעורב", "סוג הורה: לא יודע"),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("סוג הורה");
    expect(db.logCreate).not.toHaveBeenCalled();
  });
});

describe("GET /api/portal/students/[id]/communication", () => {
  it("returns the history newest first", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("REPRESENTATIVE"));
    db.logFindMany.mockResolvedValue([
      {
        id: "log-new",
        createdAt: new Date("2026-09-28T10:00:00Z"),
        type: "POST_MAPPING_CALL",
        courseContext: null,
        authorName: "שירה",
        authorRole: "REPRESENTATIVE",
        content: POST_MAPPING_CALL,
      },
      {
        id: "log-old",
        createdAt: new Date("2026-09-20T10:00:00Z"),
        type: "LESSON_SUMMARY",
        courseContext: "חבילת 3 שיעורים",
        authorName: "גדי",
        authorRole: "TEACHER",
        content: LESSON_SUMMARY,
      },
    ]);
    const { GET } = await import("../app/api/portal/students/[id]/communication/route");
    const res = await GET(new Request("https://project100.test/api/portal/students/stu-1/communication"), routeContext());

    expect(res.status).toBe(200);
    expect(db.logFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { studentId: STUDENT_ID }, orderBy: { createdAt: "desc" } })
    );
    const body = await res.json();
    expect(body.data.map((e: { id: string }) => e.id)).toEqual(["log-new", "log-old"]);
    expect(body.data[0].createdAt).toBe("2026-09-28T10:00:00.000Z");
  });

  it("refuses students", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("STUDENT", STUDENT_ID));
    const { GET } = await import("../app/api/portal/students/[id]/communication/route");
    const res = await GET(new Request("https://project100.test/api/portal/students/stu-1/communication"), routeContext());
    expect(res.status).toBe(403);
    expect(db.logFindMany).not.toHaveBeenCalled();
  });
});

describe("student screen tabs", () => {
  it("defines the tabs in order", () => {
    expect(STUDENT_TABS.map((t) => t.label)).toEqual(["סקירה כללית", "מפגשים", "תקשורת", "קורסים", "כספים"]);
  });

  it("loads profile, courses, meetings, communication and standing orders for a representative", async () => {
    db.logFindMany.mockResolvedValue([
      {
        id: "log-1",
        createdAt: new Date("2026-09-28T10:00:00Z"),
        type: "LESSON_SUMMARY",
        courseContext: null,
        authorName: "גדי",
        authorRole: "TEACHER",
        content: LESSON_SUMMARY,
      },
    ]);
    const { loadStudentPortal } = await import("../lib/student-portal");
    const data = await loadStudentPortal(STUDENT_ID, { id: "user-representative", role: "REPRESENTATIVE" }, NOW);
    expect(data).not.toBeNull();
    if (!data) return;

    expect(data.header).toEqual({ id: STUDENT_ID, name: "מתן לוי", createdAt: "2026-09-01T08:00:00.000Z" });
    expect(data.viewer).toMatchObject({ canEditProfile: true, canViewBilling: true });

    expect(data.profile).toMatchObject({
      firstName: "מתן",
      lastName: "לוי",
      phone: "054-765-4321",
      whatsappUrl: "https://wa.me/972547654321",
      parentWhatsappUrl: "https://wa.me/972521112233",
      grade: "י",
      studyGroup: "5 יח״ל",
      nationalId: "123456789",
      city: "רחובות",
      birthDate: "2010-03-15",
      age: 16,
      schoolName: "אורט רחובות",
      parentName: "רונית לוי",
      invoiceName: "רונית לוי",
      invoiceTaxId: "987654321",
      studentStatus: ["STUDENT", "FLOWING_160"],
    });

    const trio = data.courses.find((c) => c.key === "package:pkg-trio");
    expect(trio).toMatchObject({
      kind: "COURSE",
      title: "חבילת 3 שיעורים",
      enrollmentType: "SUBSCRIPTION",
      teacherName: "גדי המורה",
      nextMeetingAt: "2026-10-06T14:00:00.000Z",
      upcomingCount: 1,
      completedCount: 1,
    });
    expect(trio?.schedule).toEqual(["יום ג׳ 17:00–18:00"]);
    expect(data.courses.find((c) => c.title === "פיזיקה")).toMatchObject({ enrollmentType: "ONE_TIME", teacherName: "דנה" });
    expect(data.courses.find((c) => c.kind === "MAPPING")).toMatchObject({
      title: "שיחת מיפוי · אלגברה",
      teacherName: "שירה הנציגה",
    });

    const meeting = (id: string) => data.meetings.find((m) => m.id === id);
    expect(meeting("l-past")).toMatchObject({ attendanceStatus: "PRESENT", canMarkAttendance: true });
    expect(meeting("l-future")?.canMarkAttendance).toBe(false);
    expect(meeting("l-cancelled")?.canMarkAttendance).toBe(false);

    expect(data.communication).toHaveLength(1);
    expect(data.communication[0]).toMatchObject({ type: "LESSON_SUMMARY", authorRole: "TEACHER" });

    expect(data.standingOrders).toEqual({
      status: "ACTIVE",
      lessonCredits: 2,
      card: { state: "NOT_CONFIGURED" },
      charges: [
        {
          id: "pay-1",
          createdAt: "2026-09-02T08:00:00.000Z",
          packageType: "TRIO",
          amountPaid: 540,
          creditsAdded: 3,
          status: "COMPLETED",
        },
      ],
    });
  });

  it("hides billing from teachers and only lets them mark their own lessons", async () => {
    const { loadStudentPortal } = await import("../lib/student-portal");
    const data = await loadStudentPortal(STUDENT_ID, { id: TEACHER_ID, role: "TEACHER" }, NOW);
    expect(data?.standingOrders).toBeNull();
    expect(data?.profile.invoiceName).toBeNull();
    expect(data?.profile.invoiceTaxId).toBeNull();
    expect(data?.viewer).toMatchObject({ canEditProfile: false, canViewBilling: false });
    expect(db.paymentFindMany).not.toHaveBeenCalled();
    expect(data?.meetings.find((m) => m.id === "l-past")?.canMarkAttendance).toBe(true);
    expect(data?.meetings.find((m) => m.id === "l-physics")?.canMarkAttendance).toBe(false);
  });

  it("the page renders the five-tab screen for staff and gates everyone else", async () => {
    const { default: StudentPortalPage } = await import("../app/portal/students/[id]/page");
    const { default: StudentPortalTabs } = await import("../components/portal/student/StudentPortalTabs");
    const props = (id = STUDENT_ID, tab?: string) => ({
      params: Promise.resolve({ id }),
      searchParams: Promise.resolve(tab ? { tab } : {}),
    });

    session.getCurrentUser.mockResolvedValue(null);
    await expect(StudentPortalPage(props())).rejects.toThrow("NEXT_REDIRECT:/portal/login");

    session.getCurrentUser.mockResolvedValue(sessionUser("STUDENT", STUDENT_ID));
    await expect(StudentPortalPage(props())).rejects.toThrow("NEXT_REDIRECT:/portal/login");

    session.getCurrentUser.mockResolvedValue(sessionUser("TEACHER", "teacher-stranger"));
    await expect(StudentPortalPage(props())).rejects.toThrow("NEXT_NOT_FOUND");

    session.getCurrentUser.mockResolvedValue(sessionUser("MANAGER"));
    const tree = await StudentPortalPage(props(STUDENT_ID, "communication"));

    type Node = { type?: unknown; props?: { children?: unknown; [key: string]: unknown } };
    const find = (node: unknown): Node | null => {
      if (!node || typeof node !== "object") return null;
      if (Array.isArray(node)) {
        for (const child of node) {
          const hit = find(child);
          if (hit) return hit;
        }
        return null;
      }
      const el = node as Node;
      if (el.type === StudentPortalTabs) return el;
      return find(el.props?.children);
    };
    const tabs = find(tree);
    expect(tabs).not.toBeNull();
    expect(tabs?.props?.initialTab).toBe("communication");
    const data = tabs?.props?.data as { profile: unknown; courses: unknown[]; meetings: unknown[]; communication: unknown[]; standingOrders: unknown };
    expect(data.profile).toBeTruthy();
    expect(data.courses.length).toBeGreaterThan(0);
    expect(data.meetings).toHaveLength(LESSONS.length);
    expect(Array.isArray(data.communication)).toBe(true);
    expect(data.standingOrders).not.toBeNull();

    for (const legacy of ["standing-orders", "subscriptions", "recurring"]) {
      await expect(StudentPortalPage(props(STUDENT_ID, legacy))).rejects.toThrow(
        `NEXT_REDIRECT:/portal/students/${STUDENT_ID}?tab=billing`
      );
    }
  });
});

describe("attendance and status updates", () => {
  async function postAttendance(body: unknown) {
    const { POST } = await import("../app/api/portal/students/[id]/attendance/route");
    return POST(jsonRequest(`/api/portal/students/${STUDENT_ID}/attendance`, "POST", body), routeContext());
  }

  it("the lesson's teacher marks a started lesson present; other teachers and future lessons are refused", async () => {
    db.lessonFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      const row = LESSONS.find((l) => l.id === where.id);
      return row ? { ...row, studentId: STUDENT_ID } : null;
    });
    db.lessonUpdate.mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
      id: where.id,
      ...data,
    }));

    session.getCurrentUser.mockResolvedValue(sessionUser("TEACHER", TEACHER_ID));
    const ok = await postAttendance({ lessonId: "l-past", status: "ABSENT" });
    expect(ok.status).toBe(200);
    expect(db.lessonUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "l-past" },
        data: expect.objectContaining({ attendanceStatus: "ABSENT", attendanceMarkedById: TEACHER_ID }),
      })
    );
    expect(db.lessonUpdate.mock.calls[0][0].data).not.toHaveProperty("status");
    expect(audit.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "LESSON_ATTENDANCE_MARKED" }));

    expect((await postAttendance({ lessonId: "l-future", status: "PRESENT" })).status).toBe(409);
    expect((await postAttendance({ lessonId: "l-cancelled", status: "PRESENT" })).status).toBe(409);
    expect((await postAttendance({ lessonId: "l-physics", status: "PRESENT" })).status).toBe(403);
    expect((await postAttendance({ lessonId: "l-past", status: "LATE" })).status).toBe(400);

    session.getCurrentUser.mockResolvedValue(sessionUser("STUDENT", STUDENT_ID));
    expect((await postAttendance({ lessonId: "l-past", status: "PRESENT" })).status).toBe(403);
    expect(db.lessonUpdate).toHaveBeenCalledTimes(1);
  });

  it("representatives save status checkboxes; teachers cannot", async () => {
    db.profileUpsert.mockImplementation(async ({ update }: { update: Record<string, unknown> }) => ({
      id: "sp-1",
      studentStatus: update.studentStatus,
      statusUpdatedAt: update.statusUpdatedAt,
    }));
    const { PATCH } = await import("../app/api/portal/students/[id]/profile/route");
    const patch = (body: unknown) =>
      PATCH(jsonRequest(`/api/portal/students/${STUDENT_ID}/profile`, "PATCH", body), routeContext());

    session.getCurrentUser.mockResolvedValue(sessionUser("REPRESENTATIVE"));
    const res = await patch({ studentStatus: ["BOILING_160", "CALL_BACK_PARENT", "BOILING_160"] });
    expect(res.status).toBe(200);
    expect((await res.json()).data.studentStatus).toEqual(["CALL_BACK_PARENT", "BOILING_160"]);
    expect(audit.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "STUDENT_PROFILE_UPDATED" }));

    expect((await patch({ studentStatus: ["VIP"] })).status).toBe(400);
    expect((await patch({ fields: { nationalId: "12ab" } })).status).toBe(400);

    session.getCurrentUser.mockResolvedValue(sessionUser("TEACHER", TEACHER_ID));
    expect((await patch({ studentStatus: ["STUDENT"] })).status).toBe(403);
    expect(db.profileUpsert).toHaveBeenCalledTimes(1);
  });

  it("status parser keeps known codes in display order and age is computed from the birth date", () => {
    expect(parseStudentStatuses(["MAPPING_FAILED", "STUDENT"])).toEqual({ ok: true, data: ["STUDENT", "MAPPING_FAILED"] });
    expect(parseStudentStatuses("STUDENT").ok).toBe(false);
    expect(ageFromBirthDate("2010-09-30", NOW)).toBe(15);
    expect(ageFromBirthDate("2010-09-29", NOW)).toBe(16);
    expect(ageFromBirthDate(null, NOW)).toBeNull();
  });
});
