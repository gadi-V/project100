import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  gradeVariants,
  paginationMeta,
  parseStudentDirectoryQuery,
  STUDENT_DIRECTORY_PAGE_SIZE,
  type StudentDirectoryPage,
} from "../lib/student-directory-shared";
import { isPortalTabActive, portalExtraLinks, portalNavTabs } from "../lib/portal-nav";

type FakeProfile = {
  firstName: string | null;
  lastName: string | null;
  grade: string | null;
  studyGroup: string | null;
  city: string | null;
  studentStatus: string[];
};

type FakeUser = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  role: string;
  classTrack: string | null;
  createdAt: Date;
  studentProfile: FakeProfile | null;
  intakeAssessments: { grade: string; levelUnits: string; createdAt: Date }[];
};

type FakeLesson = {
  id: string;
  studentId: string;
  teacherId: string;
  scheduledAt: Date;
  status: string;
};

const session = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
const navigation = vi.hoisted(() => ({
  redirect: vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  usePathname: vi.fn(() => "/portal/students"),
  useRouter: vi.fn(() => ({ replace: vi.fn(), push: vi.fn() })),
}));
const store = vi.hoisted(() => ({
  users: [] as FakeUser[],
  lessons: [] as FakeLesson[],
  teachers: new Map<string, string>(),
}));
const db = vi.hoisted(() => ({
  userCount: vi.fn(),
  userFindMany: vi.fn(),
  lessonFindMany: vi.fn(),
}));

vi.mock("next/navigation", () => navigation);
vi.mock("../lib/session", () => session);
vi.mock("../lib/prisma", () => ({
  prisma: {
    user: { count: db.userCount, findMany: db.userFindMany },
    lesson: { findMany: db.lessonFindMany },
  },
}));

// ---------------------------------------------------------------------------
// In-memory evaluator for the Prisma `where` subset the directory uses.
// Unknown operators throw, so a filter the fake does not understand fails loudly.
// ---------------------------------------------------------------------------

type Where = Record<string, unknown>;

function matchValue(value: unknown, condition: unknown): boolean {
  if (condition === null) return value === null || value === undefined;
  if (typeof condition !== "object" || condition instanceof Date) {
    return value instanceof Date && condition instanceof Date
      ? value.getTime() === condition.getTime()
      : value === condition;
  }
  const ops = condition as Record<string, unknown>;
  return Object.entries(ops).every(([op, arg]) => {
    switch (op) {
      case "is":
        return arg === null ? value == null : value != null && matchWhere(value as Record<string, unknown>, arg as Where);
      case "some":
        return Array.isArray(value) && value.some((item) => matchWhere(item as Record<string, unknown>, arg as Where));
      case "hasSome":
        return Array.isArray(value) && (arg as unknown[]).some((item) => value.includes(item));
      case "in":
        return (arg as unknown[]).includes(value);
      case "notIn":
        return !(arg as unknown[]).includes(value);
      case "contains": {
        if (typeof value !== "string") return false;
        const needle = String(arg);
        return ops.mode === "insensitive" ? value.toLowerCase().includes(needle.toLowerCase()) : value.includes(needle);
      }
      case "mode":
        return true;
      case "gte":
        return value instanceof Date && value.getTime() >= (arg as Date).getTime();
      case "lt":
        return value instanceof Date && value.getTime() < (arg as Date).getTime();
      default:
        throw new Error(`fake prisma: unsupported operator ${op}`);
    }
  });
}

function matchWhere(record: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "AND") return (condition as Where[]).every((w) => matchWhere(record, w));
    if (key === "OR") return (condition as Where[]).some((w) => matchWhere(record, w));
    if (key === "NOT") return !matchWhere(record, condition as Where);
    return matchValue(record[key], condition);
  });
}

function userRecord(user: FakeUser): Record<string, unknown> {
  return { ...user, takenLessons: store.lessons.filter((l) => l.studentId === user.id) };
}

function filteredUsers(where: Where): FakeUser[] {
  return store.users.filter((user) => matchWhere(userRecord(user), where));
}

function installFakePrisma() {
  db.userCount.mockImplementation(async ({ where }: { where: Where }) => filteredUsers(where).length);
  db.userFindMany.mockImplementation(
    async ({ where, skip = 0, take }: { where: Where; skip?: number; take?: number }) =>
      filteredUsers(where)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id))
        .slice(skip, take === undefined ? undefined : skip + take)
        .map((user) => ({
          id: user.id,
          name: user.name,
          phone: user.phone,
          classTrack: user.classTrack,
          studentProfile: user.studentProfile,
          intakeAssessments: [...user.intakeAssessments]
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(0, 1)
            .map(({ grade, levelUnits }) => ({ grade, levelUnits })),
        }))
  );
  db.lessonFindMany.mockImplementation(
    async ({ where, orderBy, distinct }: { where: Where; orderBy: { scheduledAt: "asc" | "desc" }; distinct?: string[] }) => {
      const direction = orderBy.scheduledAt === "asc" ? 1 : -1;
      const rows = store.lessons
        .filter((lesson) => matchWhere(lesson, where))
        .sort((a, b) => direction * (a.scheduledAt.getTime() - b.scheduledAt.getTime()));
      const seen = new Set<string>();
      return rows
        .filter((lesson) => {
          if (!distinct?.includes("studentId")) return true;
          if (seen.has(lesson.studentId)) return false;
          seen.add(lesson.studentId);
          return true;
        })
        .map((lesson) => ({
          studentId: lesson.studentId,
          scheduledAt: lesson.scheduledAt,
          teacher: { name: store.teachers.get(lesson.teacherId) ?? "" },
        }));
    }
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-09-29T12:00:00Z");
const TEACHER_A = "teacher-a";
const TEACHER_B = "teacher-b";

type Role = "STUDENT" | "TEACHER" | "ADMIN" | "MANAGER" | "REPRESENTATIVE";

const sessionUser = (role: Role, id = `user-${role.toLowerCase()}`) => ({
  id,
  name: `משתמש ${role}`,
  role,
  lessonCredits: 0,
  isApproved: true,
});

const profile = (overrides: Partial<FakeProfile>): FakeProfile => ({
  firstName: null,
  lastName: null,
  grade: null,
  studyGroup: null,
  city: null,
  studentStatus: [],
  ...overrides,
});

function baseUsers(): FakeUser[] {
  return [
    {
      id: "stu-matan",
      name: "מתן לוי",
      phone: "0547654321",
      email: "matan@example.com",
      role: "STUDENT",
      classTrack: null,
      createdAt: new Date("2026-09-20T08:00:00Z"),
      studentProfile: profile({
        firstName: "מתן",
        lastName: "לוי",
        grade: "י",
        studyGroup: "5 יח״ל",
        city: "רחובות",
        studentStatus: ["STUDENT", "BOILING_160"],
      }),
      intakeAssessments: [],
    },
    {
      id: "stu-noa",
      name: "נועה כהן",
      phone: "+972521112233",
      email: "noa@example.com",
      role: "STUDENT",
      classTrack: null,
      createdAt: new Date("2026-09-18T08:00:00Z"),
      studentProfile: profile({ city: "חיפה", grade: "יא׳", studentStatus: ["CALL_BACK_PARENT"] }),
      intakeAssessments: [],
    },
    {
      id: "stu-yoni",
      name: "יוני אברהם",
      phone: "050-333-4444",
      email: null,
      role: "STUDENT",
      classTrack: "4 יח״ל",
      createdAt: new Date("2026-09-15T08:00:00Z"),
      studentProfile: null,
      intakeAssessments: [
        { grade: "ח", levelUnits: "3 יח״ל", createdAt: new Date("2026-06-01T08:00:00Z") },
        { grade: "ט", levelUnits: "4 יח״ל", createdAt: new Date("2026-09-16T08:00:00Z") },
      ],
    },
    {
      id: "stu-dana",
      name: "דנה ישראלי",
      phone: "0539998877",
      email: "dana@example.com",
      role: "STUDENT",
      classTrack: null,
      createdAt: new Date("2026-09-10T08:00:00Z"),
      studentProfile: profile({ city: "רחובות", studentStatus: ["BOILING_160", "SUBSCRIPTION_CANCELLED"] }),
      intakeAssessments: [],
    },
    {
      id: TEACHER_A,
      name: "גדי המורה",
      phone: "0501234567",
      email: "gadi@example.com",
      role: "TEACHER",
      classTrack: null,
      createdAt: new Date("2026-09-25T08:00:00Z"),
      studentProfile: null,
      intakeAssessments: [],
    },
  ];
}

function baseLessons(): FakeLesson[] {
  return [
    { id: "l-matan-next", studentId: "stu-matan", teacherId: TEACHER_A, scheduledAt: new Date("2026-10-06T14:00:00Z"), status: "SCHEDULED" },
    { id: "l-matan-past", studentId: "stu-matan", teacherId: TEACHER_A, scheduledAt: new Date("2026-09-22T14:00:00Z"), status: "COMPLETED" },
    { id: "l-noa-past", studentId: "stu-noa", teacherId: TEACHER_B, scheduledAt: new Date("2026-09-21T15:00:00Z"), status: "COMPLETED" },
    { id: "l-yoni-next-b", studentId: "stu-yoni", teacherId: TEACHER_B, scheduledAt: new Date("2026-10-01T16:00:00Z"), status: "SCHEDULED" },
    { id: "l-yoni-past-a", studentId: "stu-yoni", teacherId: TEACHER_A, scheduledAt: new Date("2026-09-08T16:00:00Z"), status: "COMPLETED" },
    { id: "l-yoni-cancelled-a", studentId: "stu-yoni", teacherId: TEACHER_A, scheduledAt: new Date("2026-09-24T16:00:00Z"), status: "CANCELLED" },
  ];
}

async function getDirectory(query = "") {
  const { GET } = await import("../app/api/portal/students/route");
  return GET(new Request(`https://project100.test/api/portal/students${query ? `?${query}` : ""}`));
}

async function directoryPage(query = ""): Promise<StudentDirectoryPage> {
  const res = await getDirectory(query);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { success: boolean; data: StudentDirectoryPage };
  expect(body.success).toBe(true);
  return body.data;
}

const ids = (page: StudentDirectoryPage) => page.students.map((s) => s.id);

function readSource(file: string): string {
  return readFileSync(path.join(process.cwd(), file), "utf8");
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("AUTH_SECRET", "vitest-auth-secret-at-least-32-characters");
  store.users = baseUsers();
  store.lessons = baseLessons();
  store.teachers = new Map([
    [TEACHER_A, "גדי המורה"],
    [TEACHER_B, "דנה המורה"],
  ]);
  session.getCurrentUser.mockResolvedValue(null);
  installFakePrisma();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------

describe("GET /api/portal/students — access", () => {
  it("answers 401 without a session and never touches the database", async () => {
    const res = await getDirectory();
    expect(res.status).toBe(401);
    expect(db.userCount).not.toHaveBeenCalled();
    expect(db.userFindMany).not.toHaveBeenCalled();
  });

  it("answers 403 to a student", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("STUDENT", "stu-matan"));
    const res = await getDirectory();
    expect(res.status).toBe(403);
    expect(db.userCount).not.toHaveBeenCalled();
  });

  it.each(["REPRESENTATIVE", "ADMIN", "MANAGER"] as const)("%s sees every student and no other role", async (role) => {
    session.getCurrentUser.mockResolvedValue(sessionUser(role));
    const page = await directoryPage();
    expect(ids(page)).toEqual(["stu-matan", "stu-noa", "stu-yoni", "stu-dana"]);
    expect(page.totalCount).toBe(4);
  });

  it("returns the row shape: name, phone, WhatsApp, grade, group, statuses, lessons, teacher", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("REPRESENTATIVE"));
    const page = await directoryPage();
    const matan = page.students.find((s) => s.id === "stu-matan");
    expect(matan).toEqual({
      id: "stu-matan",
      fullName: "מתן לוי",
      phone: "0547654321",
      whatsappUrl: "https://wa.me/972547654321",
      grade: "י",
      studyGroup: "5 יח״ל",
      city: "רחובות",
      statuses: ["STUDENT", "BOILING_160"],
      nextLessonAt: "2026-10-06T14:00:00.000Z",
      lastLessonAt: "2026-09-22T14:00:00.000Z",
      teacherName: "גדי המורה",
    });

    const yoni = page.students.find((s) => s.id === "stu-yoni");
    expect(yoni).toMatchObject({ grade: "ט", studyGroup: "4 יח״ל", statuses: [], teacherName: "דנה המורה" });
    expect(page.students.find((s) => s.id === "stu-dana")).toMatchObject({
      nextLessonAt: null,
      lastLessonAt: null,
      teacherName: null,
    });
  });

  it("ignores identity hints in the query string", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("TEACHER", TEACHER_B));
    const page = await directoryPage(`teacherId=${TEACHER_A}&userId=${TEACHER_A}`);
    expect(ids(page).sort()).toEqual(["stu-noa", "stu-yoni"]);
  });
});

describe("teacher data isolation", () => {
  it("a teacher gets only students they have lessons with", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("TEACHER", TEACHER_A));
    const page = await directoryPage();
    expect(ids(page)).toEqual(["stu-matan", "stu-yoni"]);
    expect(ids(page)).not.toContain("stu-noa");
    expect(ids(page)).not.toContain("stu-dana");
    expect(page.totalCount).toBe(2);
  });

  it("the other teacher gets a disjoint set", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("TEACHER", TEACHER_B));
    const page = await directoryPage();
    expect(ids(page)).toEqual(["stu-noa", "stu-yoni"]);
  });

  it("lesson columns show only the teacher's own lessons", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("TEACHER", TEACHER_A));
    const page = await directoryPage();
    const yoni = page.students.find((s) => s.id === "stu-yoni");
    expect(yoni).toMatchObject({
      nextLessonAt: null,
      lastLessonAt: "2026-09-08T16:00:00.000Z",
      teacherName: "גדי המורה",
    });
    for (const call of db.lessonFindMany.mock.calls) {
      expect(call[0].where.teacherId).toBe(TEACHER_A);
    }
  });

  it("a teacher cannot widen the set with search or status filters", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("TEACHER", TEACHER_A));
    expect(ids(await directoryPage(`search=${encodeURIComponent("נועה")}`))).toEqual([]);
    expect(ids(await directoryPage("status=BOILING_160"))).toEqual(["stu-matan"]);
  });

  it("a teacher with no lessons gets an empty list", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("TEACHER", "teacher-new"));
    const page = await directoryPage();
    expect(page).toEqual({ students: [], totalCount: 0, page: 1, limit: 25, totalPages: 1 });
  });
});

describe("text search", () => {
  beforeEach(() => {
    session.getCurrentUser.mockResolvedValue(sessionUser("REPRESENTATIVE"));
  });

  const search = (term: string) => directoryPage(`search=${encodeURIComponent(term)}`).then(ids);

  it("matches first name, last name and the full name", async () => {
    expect(await search("מתן")).toEqual(["stu-matan"]);
    expect(await search("לוי")).toEqual(["stu-matan"]);
    expect(await search("מתן לוי")).toEqual(["stu-matan"]);
    expect(await search("אברהם")).toEqual(["stu-yoni"]);
  });

  it("matches phone numbers across local and international spellings", async () => {
    expect(await search("0547654321")).toEqual(["stu-matan"]);
    expect(await search("0521112233")).toEqual(["stu-noa"]);
    expect(await search("+972547654321")).toEqual(["stu-matan"]);
    expect(await search("333-4444")).toEqual(["stu-yoni"]);
  });

  it("matches email and city", async () => {
    expect(await search("NOA@EXAMPLE")).toEqual(["stu-noa"]);
    expect(await search("רחובות")).toEqual(["stu-matan", "stu-dana"]);
    expect(await search("חיפה")).toEqual(["stu-noa"]);
  });

  it("never returns non-students and returns nothing for an unknown term", async () => {
    expect(await search("גדי")).toEqual([]);
    expect(await search("0501234567")).toEqual([]);
    expect(await search("ירושלים")).toEqual([]);
  });

  it("requires every word to match", async () => {
    expect(await search("רחובות דנה")).toEqual(["stu-dana"]);
    expect(await search("רחובות נועה")).toEqual([]);
  });
});

describe("status and grade filters", () => {
  beforeEach(() => {
    session.getCurrentUser.mockResolvedValue(sessionUser("MANAGER"));
  });

  it("filters by studentStatus code", async () => {
    expect(ids(await directoryPage("status=BOILING_160"))).toEqual(["stu-matan", "stu-dana"]);
    expect(ids(await directoryPage("status=CALL_BACK_PARENT"))).toEqual(["stu-noa"]);
  });

  it("accepts the Hebrew labels רותח 160 and לחזור להורה", async () => {
    expect(ids(await directoryPage(`status=${encodeURIComponent("רותח 160")}`))).toEqual(["stu-matan", "stu-dana"]);
    expect(ids(await directoryPage(`status=${encodeURIComponent("לחזור להורה")}`))).toEqual(["stu-noa"]);
  });

  it("several statuses match any of them; הכל means no filter", async () => {
    expect(ids(await directoryPage("status=CALL_BACK_PARENT,SUBSCRIPTION_CANCELLED"))).toEqual(["stu-noa", "stu-dana"]);
    expect(ids(await directoryPage(`status=${encodeURIComponent("הכל")}`))).toHaveLength(4);
  });

  it("students without a profile never match a status filter", async () => {
    expect(ids(await directoryPage("status=STUDENT"))).toEqual(["stu-matan"]);
  });

  it("combines status with search", async () => {
    const term = encodeURIComponent("רחובות");
    expect(ids(await directoryPage(`status=SUBSCRIPTION_CANCELLED&search=${term}`))).toEqual(["stu-dana"]);
  });

  it("rejects an unknown status with 400", async () => {
    const res = await getDirectory("status=VIP");
    expect(res.status).toBe(400);
    expect(db.userCount).not.toHaveBeenCalled();
  });

  it("filters by grade from the profile, else from the intake assessments", async () => {
    expect(ids(await directoryPage(`grade=${encodeURIComponent("י׳")}`))).toEqual(["stu-matan"]);
    expect(ids(await directoryPage(`grade=${encodeURIComponent("יא׳")}`))).toEqual(["stu-noa"]);
    expect(ids(await directoryPage(`grade=${encodeURIComponent("ט׳")}`))).toEqual(["stu-yoni"]);
    expect(ids(await directoryPage(`grade=${encodeURIComponent("ז׳")}`))).toEqual([]);
    expect((await getDirectory("grade=13")).status).toBe(400);
  });

  it("grade spellings cover geresh, apostrophe, gershayim and numbers", () => {
    expect(gradeVariants("י׳")).toEqual(expect.arrayContaining(["י", "י׳", "י'", "10", "כיתה י׳"]));
    expect(gradeVariants("יא׳")).toEqual(expect.arrayContaining(["יא", "יא׳", "י״א", 'י"א', "11"]));
  });
});

describe("pagination", () => {
  it("computes page count, clamping and offsets", () => {
    expect(paginationMeta(0, 1, 25)).toEqual({ totalCount: 0, page: 1, limit: 25, totalPages: 1, skip: 0 });
    expect(paginationMeta(25, 1, 25)).toMatchObject({ totalPages: 1, skip: 0 });
    expect(paginationMeta(26, 2, 25)).toMatchObject({ totalPages: 2, page: 2, skip: 25 });
    expect(paginationMeta(51, 3, 25)).toMatchObject({ totalPages: 3, page: 3, skip: 50 });
    expect(paginationMeta(30, 9, 25)).toMatchObject({ page: 2, skip: 25 });
    expect(paginationMeta(30, 0, 25)).toMatchObject({ page: 1, skip: 0 });
  });

  it("parses page and limit with safe defaults and a cap", () => {
    const parse = (qs: string) => {
      const result = parseStudentDirectoryQuery(new URLSearchParams(qs));
      if (!result.ok) throw new Error(result.errors.join());
      return result.data;
    };
    expect(parse("")).toMatchObject({ page: 1, limit: STUDENT_DIRECTORY_PAGE_SIZE });
    expect(parse("page=3&limit=10")).toMatchObject({ page: 3, limit: 10 });
    expect(parse("page=-2&limit=abc")).toMatchObject({ page: 1, limit: 25 });
    expect(parse("limit=5000")).toMatchObject({ limit: 100 });
    expect(parse("search=%20%20מתן%20%20%20לוי%20")).toMatchObject({ search: "מתן לוי", searchTokens: ["מתן", "לוי"] });
  });

  describe("over the API", () => {
    beforeEach(() => {
      session.getCurrentUser.mockResolvedValue(sessionUser("ADMIN"));
      for (let i = 0; i < 30; i += 1) {
        store.users.push({
          id: `stu-bulk-${String(i).padStart(2, "0")}`,
          name: `תלמיד ${i}`,
          phone: `05800000${String(i).padStart(2, "0")}`,
          email: null,
          role: "STUDENT",
          classTrack: null,
          createdAt: new Date(Date.UTC(2026, 7, 1, 8, i)),
          studentProfile: null,
          intakeAssessments: [],
        });
      }
    });

    it("returns 25 per page by default with totals", async () => {
      const first = await directoryPage();
      expect(first.students).toHaveLength(25);
      expect(first).toMatchObject({ totalCount: 34, page: 1, limit: 25, totalPages: 2 });

      const second = await directoryPage("page=2");
      expect(second.students).toHaveLength(9);
      expect(second).toMatchObject({ totalCount: 34, page: 2, totalPages: 2 });

      const seen = new Set([...ids(first), ...ids(second)]);
      expect(seen.size).toBe(34);
    });

    it("pulls a page past the end back to the last page", async () => {
      const page = await directoryPage("page=99&limit=10");
      expect(page).toMatchObject({ page: 4, totalPages: 4, limit: 10 });
      expect(page.students).toHaveLength(4);
      expect(db.userFindMany.mock.calls[0][0]).toMatchObject({ skip: 30, take: 10 });
    });

    it("counts only the filtered rows", async () => {
      const page = await directoryPage("status=BOILING_160&limit=1");
      expect(page).toMatchObject({ totalCount: 2, totalPages: 2, page: 1 });
      expect(page.students).toHaveLength(1);
    });
  });
});

describe("/portal/students page and navigation", () => {
  it("sends anonymous users and students to the staff gate", async () => {
    const { default: Page } = await import("../app/portal/students/page");
    const props = { searchParams: Promise.resolve({}) };
    await expect(Page(props)).rejects.toThrow("NEXT_REDIRECT:/portal/login");
    session.getCurrentUser.mockResolvedValue(sessionUser("STUDENT"));
    await expect(Page(props)).rejects.toThrow("NEXT_REDIRECT:/portal/login");
  });

  it.each(["TEACHER", "REPRESENTATIVE", "ADMIN", "MANAGER"] as const)("renders for %s", async (role) => {
    session.getCurrentUser.mockResolvedValue(sessionUser(role));
    const { default: Page } = await import("../app/portal/students/page");
    await expect(Page({ searchParams: Promise.resolve({ search: "מתן" }) })).resolves.toBeTruthy();
    expect(navigation.redirect).not.toHaveBeenCalled();
  });

  it("offers היום / קורסים / לקוחות tabs routed per role", () => {
    const labels = (role: string) => portalNavTabs(role).map((t) => `${t.label}:${t.href}`);
    expect(labels("ADMIN")).toEqual(["היום:/portal/dashboard", "קורסים:/admin/lessons", "לקוחות:/portal/students"]);
    expect(labels("TEACHER")).toEqual(["היום:/dashboard", "קורסים:/dashboard#teacher-lessons", "לקוחות:/portal/students"]);
    expect(labels("REPRESENTATIVE")).toEqual(["היום:/portal/dashboard", "לקוחות:/portal/students"]);
    expect(portalExtraLinks("TEACHER")).toEqual([]);
    expect(portalExtraLinks("REPRESENTATIVE").map((l) => l.href)).toEqual(["/portal/intake"]);

    const students = portalNavTabs("MANAGER").find((t) => t.key === "students");
    expect(students && isPortalTabActive(students, "/portal/students/stu-1")).toBe(true);
    expect(students && isPortalTabActive(students, "/portal/studentsx")).toBe(false);
  });

  it("uses the shared header on every portal page and links teachers to the student file", () => {
    for (const file of [
      "app/portal/students/page.tsx",
      "app/portal/students/[id]/page.tsx",
      "app/portal/dashboard/page.tsx",
      "app/portal/intake/page.tsx",
    ]) {
      expect(readSource(file), file).toMatch(/import PortalHeader from "(\.\.\/)+components\/portal\/PortalHeader"/);
    }
    const header = readSource("components/portal/PortalHeader.tsx");
    expect(header).toContain("/api/portal/students?");
    expect(header).toContain("STAFF_ROLE_LABELS");

    const dashboard = readSource("app/dashboard/page.tsx");
    expect(dashboard).toContain("`/portal/students/${encodeURIComponent(studentId)}`");
    expect(dashboard.match(/תיק תלמיד \/ סיכומים/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("uses relative imports only in the sprint files", () => {
    for (const file of [
      "app/api/portal/students/route.ts",
      "app/portal/students/page.tsx",
      "components/portal/PortalHeader.tsx",
      "components/portal/StudentDirectory.tsx",
      "components/portal/useDebouncedValue.ts",
      "app/dashboard/page.tsx",
      "lib/student-directory.ts",
      "lib/student-directory-shared.ts",
      "lib/portal-nav.ts",
    ]) {
      expect(readSource(file), file).not.toMatch(/from\s+["']@\//);
    }
  });
});
