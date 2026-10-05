import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ONBOARDING_STORAGE_KEY,
  normalizeIsraeliMobile,
  parseOnboardingAnswers,
  type OnboardingAnswers,
} from "../lib/student-onboarding";

const readSource = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

const session = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
const google = vi.hoisted(() => ({ exchangeCodeForIdentity: vi.fn() }));
const db = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userFindFirst: vi.fn(),
  userCreate: vi.fn(),
  userUpdate: vi.fn(),
  studentProfileUpsert: vi.fn(),
  diagnosticQuizCreate: vi.fn(),
}));

vi.mock("../lib/session", () => session);
vi.mock("../lib/auth/google-oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/auth/google-oauth")>()),
  exchangeCodeForIdentity: google.exchangeCodeForIdentity,
}));
vi.mock("../lib/prisma", () => {
  const client = {
    user: {
      findUnique: db.userFindUnique,
      findFirst: db.userFindFirst,
      create: db.userCreate,
      update: db.userUpdate,
    },
    studentProfile: { upsert: db.studentProfileUpsert },
    diagnosticQuiz: { create: db.diagnosticQuizCreate },
    $transaction: vi.fn(async (run: (tx: unknown) => unknown) => run(client)),
  };
  return { prisma: client };
});

const SCHOOL_ANSWERS: OnboardingAnswers = {
  path: "school",
  schoolGrade: "כיתה יא'",
  schoolUnits: "5",
  schoolSubject: "מתמטיקה",
  academicInstitution: "",
  academicDegree: "",
  academicCourse: "",
  bottleneck: "anxiety",
  goalType: "marathon",
};

const ACADEMIC_ANSWERS: OnboardingAnswers = {
  path: "academia",
  schoolGrade: "",
  schoolUnits: "",
  schoolSubject: "",
  academicInstitution: "הטכניון",
  academicDegree: "הנדסת מכונות",
  academicCourse: "אינפי 1",
  bottleneck: "gaps",
  goalType: "semester",
};

const SIGNUP = {
  firstName: "נועה",
  lastName: "כהן",
  phone: "050-123-4567",
  email: "noa@example.com",
  password: "secret123",
  acceptTerms: true,
  whatsappUpdates: false,
  answers: SCHOOL_ANSWERS,
};

type CreateArgs = {
  data: {
    name: string;
    phone: string;
    email: string | null;
    role: string;
    lessonCredits: number;
    googleSub: string | null;
    termsAcceptedAt: Date;
    whatsappUpdatesConsentAt: Date | null;
    trackType?: string;
    classTrack?: string | null;
    schoolName?: string | null;
    degreeField?: string | null;
    studentProfile: { create: Record<string, unknown> };
    diagnosticQuizzes?: { create: { ageGroup: string; subject: string; challenge: string } };
  };
};

const createdWith = () => db.userCreate.mock.calls[0][0] as CreateArgs;

function postJson(url: string, body: unknown, cookie?: string) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

const registerStudent = async () => (await import("../app/api/register/student/route")).POST;

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("AUTH_SECRET", "vitest-auth-secret-at-least-32-characters");
  session.getCurrentUser.mockResolvedValue(null);
  db.userFindUnique.mockResolvedValue(null);
  db.userFindFirst.mockResolvedValue(null);
  db.userCreate.mockImplementation(async ({ data }: CreateArgs) => ({ id: "stu-new", name: data.name }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("onboarding answers and phone validation", () => {
  it("accepts complete school and academic answers", () => {
    expect(parseOnboardingAnswers(SCHOOL_ANSWERS)).toEqual({ ok: true, value: SCHOOL_ANSWERS });
    expect(parseOnboardingAnswers(ACADEMIC_ANSWERS)).toEqual({ ok: true, value: ACADEMIC_ANSWERS });
  });

  it("rejects answers missing the path, grade, course, challenge or goal", () => {
    expect(parseOnboardingAnswers(null).ok).toBe(false);
    expect(parseOnboardingAnswers({ ...SCHOOL_ANSWERS, path: "" }).ok).toBe(false);
    expect(parseOnboardingAnswers({ ...SCHOOL_ANSWERS, schoolGrade: " " }).ok).toBe(false);
    expect(parseOnboardingAnswers({ ...ACADEMIC_ANSWERS, academicCourse: "" }).ok).toBe(false);
    expect(parseOnboardingAnswers({ ...SCHOOL_ANSWERS, bottleneck: "other" }).ok).toBe(false);
    expect(parseOnboardingAnswers({ ...SCHOOL_ANSWERS, goalType: "" }).ok).toBe(false);
  });

  it.each([
    ["050-123-4567", "0501234567"],
    ["0541234567", "0541234567"],
    ["+972 54 123 4567", "0541234567"],
    ["972541234567", "0541234567"],
  ])("normalizes the Israeli mobile %s", (input, expected) => {
    expect(normalizeIsraeliMobile(input)).toBe(expected);
  });

  it.each(["", "03-1234567", "050-12345", "+1 202 555 0100", "abc"])("rejects %j", (input) => {
    expect(normalizeIsraeliMobile(input)).toBeNull();
  });
});

describe("POST /api/register/student", () => {
  it("creates a STUDENT with profile and diagnostic in one transaction, without a package", async () => {
    const POST = await registerStudent();
    const res = await POST(postJson("https://project100.test/api/register/student", SIGNUP));

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      success: true,
      data: { name: "נועה כהן", redirectTo: "/dashboard" },
    });
    expect(res.cookies.get("project8_session")?.value).toBeTruthy();

    expect(db.userCreate).toHaveBeenCalledTimes(1);
    const { data } = createdWith();
    expect(data).toMatchObject({
      name: "נועה כהן",
      phone: "0501234567",
      email: "noa@example.com",
      role: "STUDENT",
      lessonCredits: 0,
      googleSub: null,
      whatsappUpdatesConsentAt: null,
      trackType: "BAGRUT",
      classTrack: "5 יח״ל",
    });
    expect(data.termsAcceptedAt).toBeInstanceOf(Date);
    expect(data).not.toHaveProperty("packageType");
    expect(data.studentProfile.create).toEqual({
      firstName: "נועה",
      lastName: "כהן",
      grade: "כיתה יא'",
      studyGroup: "5 יח״ל",
    });
    const diagnostic = data.diagnosticQuizzes?.create;
    expect(diagnostic).toMatchObject({ ageGroup: "בית ספר - כיתה יא'", subject: "מתמטיקה" });
    expect(JSON.parse(diagnostic?.challenge ?? "{}")).toMatchObject({
      path: "school",
      schoolGrade: "כיתה יא'",
      schoolUnits: "5",
      bottleneck: "anxiety",
      goalType: "marathon",
    });
  });

  it("stores the academic institution, degree and course, and the WhatsApp opt-in", async () => {
    const POST = await registerStudent();
    const res = await POST(
      postJson("https://project100.test/api/register/student", {
        ...SIGNUP,
        whatsappUpdates: true,
        answers: ACADEMIC_ANSWERS,
      })
    );

    expect(res.status).toBe(201);
    const { data } = createdWith();
    expect(data).toMatchObject({
      trackType: "ACADEMIC",
      schoolName: "הטכניון",
      degreeField: "הנדסת מכונות",
    });
    expect(data.whatsappUpdatesConsentAt).toBeInstanceOf(Date);
    expect(data.diagnosticQuizzes?.create.subject).toBe("אינפי 1");
    expect(JSON.parse(data.diagnosticQuizzes?.create.challenge ?? "{}")).toMatchObject({
      academicInstitution: "הטכניון",
      academicDegree: "הנדסת מכונות",
      bottleneck: "gaps",
      goalType: "semester",
    });
  });

  it.each([
    ["terms not accepted", { acceptTerms: false }],
    ["landline phone", { phone: "03-1234567" }],
    ["missing last name", { lastName: "" }],
    ["invalid email", { email: "not-an-email" }],
    ["short password", { password: "123" }],
    ["missing study answers", { answers: undefined }],
  ])("rejects a sign-up with %s", async (_label, override) => {
    const POST = await registerStudent();
    const res = await POST(
      postJson("https://project100.test/api/register/student", { ...SIGNUP, ...override })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).success).toBe(false);
    expect(db.userCreate).not.toHaveBeenCalled();
  });

  it("refuses a phone number that is already registered", async () => {
    db.userFindUnique.mockResolvedValue({ id: "existing" });
    const POST = await registerStudent();
    const res = await POST(postJson("https://project100.test/api/register/student", SIGNUP));
    expect(res.status).toBe(409);
    expect(db.userCreate).not.toHaveBeenCalled();
  });
});

describe("Google sign-in", () => {
  const IDENTITY = { sub: "google-sub-1", email: "dana@gmail.com", givenName: "דנה", familyName: "לוי" };

  async function pendingCookie() {
    const { signPendingGoogleSignup } = await import("../lib/auth/google-oauth");
    return `project8_google_pending=${await signPendingGoogleSignup(IDENTITY)}`;
  }

  it("sends the student back to the form when Google is not configured", async () => {
    const { GET } = await import("../app/api/auth/google/route");
    const res = await GET(new NextRequest("https://project100.test/api/auth/google"));
    expect(res.headers.get("location")).toBe("https://project100.test/register/student?google=unavailable");
  });

  it("redirects to Google with a state cookie when configured", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret");
    const { GET } = await import("../app/api/auth/google/route");
    const res = await GET(new NextRequest("https://project100.test/api/auth/google"));
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.searchParams.get("redirect_uri")).toBe("https://project100.test/api/auth/google/callback");
    expect(location.searchParams.get("state")).toBe(res.cookies.get("project8_google_state")?.value);
  });

  describe("callback", () => {
    beforeEach(() => {
      vi.stubEnv("GOOGLE_CLIENT_ID", "client-id");
      vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret");
      google.exchangeCodeForIdentity.mockResolvedValue(IDENTITY);
    });

    const callback = async (state = "s1", cookieState = "s1") => {
      const { GET } = await import("../app/api/auth/google/callback/route");
      return GET(
        new NextRequest(`https://project100.test/api/auth/google/callback?code=c1&state=${state}`, {
          headers: { cookie: `project8_google_state=${cookieState}` },
        })
      );
    };

    it("rejects a mismatched state without contacting Google", async () => {
      const res = await callback("s1", "other");
      expect(res.headers.get("location")).toBe("https://project100.test/register/student?google=failed");
      expect(google.exchangeCodeForIdentity).not.toHaveBeenCalled();
    });

    it("parks a new identity in the pending cookie and opens /auth/callback", async () => {
      const res = await callback();
      expect(res.headers.get("location")).toBe("https://project100.test/auth/callback");
      expect(res.cookies.get("project8_google_pending")?.value).toBeTruthy();
      expect(res.cookies.get("project8_session")).toBeUndefined();
    });

    it("signs in an existing student and links the Google account", async () => {
      db.userFindFirst.mockResolvedValue({ id: "stu-1", role: "STUDENT", googleSub: null });
      const res = await callback();
      expect(res.headers.get("location")).toBe("https://project100.test/auth/callback");
      expect(res.cookies.get("project8_session")?.value).toBeTruthy();
      expect(db.userUpdate).toHaveBeenCalledWith({ where: { id: "stu-1" }, data: { googleSub: "google-sub-1" } });
    });

    it("never signs in a staff account through Google", async () => {
      db.userFindFirst.mockResolvedValue({ id: "t-1", role: "TEACHER", googleSub: null });
      const res = await callback();
      expect(res.headers.get("location")).toBe("https://project100.test/register/student?google=staff");
      expect(res.cookies.get("project8_session")).toBeUndefined();
    });
  });

  describe("completion", () => {
    const complete = async () => (await import("../app/api/auth/google/complete/route")).POST;

    it("creates the Google student with phone, consent and the step 1-3 answers", async () => {
      const POST = await complete();
      const res = await POST(
        postJson(
          "https://project100.test/api/auth/google/complete",
          {
            firstName: "דנה",
            lastName: "לוי",
            phone: "052-765-4321",
            acceptTerms: true,
            whatsappUpdates: true,
            answers: ACADEMIC_ANSWERS,
          },
          await pendingCookie()
        )
      );

      expect(res.status).toBe(201);
      expect((await res.json()).data).toEqual({ redirectTo: "/dashboard" });
      expect(res.cookies.get("project8_session")?.value).toBeTruthy();
      expect(res.cookies.get("project8_google_pending")?.value).toBe("");

      const { data } = createdWith();
      expect(data).toMatchObject({
        name: "דנה לוי",
        phone: "0527654321",
        email: "dana@gmail.com",
        googleSub: "google-sub-1",
        role: "STUDENT",
        lessonCredits: 0,
        schoolName: "הטכניון",
        degreeField: "הנדסת מכונות",
      });
      expect(data.whatsappUpdatesConsentAt).toBeInstanceOf(Date);
      expect(data.studentProfile.create).toMatchObject({ firstName: "דנה", lastName: "לוי" });
      expect(data.diagnosticQuizzes?.create.subject).toBe("אינפי 1");
    });

    it("requires the terms checkbox for a new Google student", async () => {
      const POST = await complete();
      const res = await POST(
        postJson(
          "https://project100.test/api/auth/google/complete",
          { firstName: "דנה", lastName: "לוי", phone: "0527654321", acceptTerms: false },
          await pendingCookie()
        )
      );
      expect(res.status).toBe(400);
      expect(db.userCreate).not.toHaveBeenCalled();
    });

    it("refuses to create an account without a verified Google identity", async () => {
      const POST = await complete();
      const res = await POST(
        postJson("https://project100.test/api/auth/google/complete", {
          firstName: "דנה",
          lastName: "לוי",
          phone: "0527654321",
          acceptTerms: true,
        })
      );
      expect(res.status).toBe(401);
      expect(db.userCreate).not.toHaveBeenCalled();
    });

    it("saves the answers to the profile of a student who is already signed in", async () => {
      session.getCurrentUser.mockResolvedValue({ id: "stu-1", name: "דנה", role: "STUDENT", lessonCredits: 0, isApproved: true });
      const POST = await complete();
      const res = await POST(
        postJson("https://project100.test/api/auth/google/complete", { answers: SCHOOL_ANSWERS })
      );

      expect(res.status).toBe(200);
      expect(db.userUpdate).toHaveBeenCalledWith({
        where: { id: "stu-1" },
        data: { trackType: "BAGRUT", classTrack: "5 יח״ל" },
      });
      expect(db.studentProfileUpsert).toHaveBeenCalledWith({
        where: { userId: "stu-1" },
        create: { userId: "stu-1", grade: "כיתה יא'", studyGroup: "5 יח״ל" },
        update: { grade: "כיתה יא'", studyGroup: "5 יח״ל" },
      });
      expect(db.diagnosticQuizCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ studentId: "stu-1", subject: "מתמטיקה" }),
      });
      expect(db.userCreate).not.toHaveBeenCalled();
    });
  });
});

describe("wizard step 4 source", () => {
  const wizard = readSource("app/register/student/page.tsx");

  it("has no package selection or payment at sign-up", () => {
    for (const removed of ["שיעור מיפוי בודד", "כרטיסיית 3", "כרטיסיית 5", "selectedCard", "/api/payments"]) {
      expect(wizard).not.toContain(removed);
    }
  });

  it("offers Google first, then the orange manual form", () => {
    expect(wizard).toContain("יצירת חשבון וסיום רישום");
    expect(wizard).toContain("הפרטים נשמרים ישירות לתיק התלמיד האישי שלך");
    expect(wizard).toContain("המשך עם Google");
    expect(wizard).toContain('window.location.href = "/api/auth/google"');
    expect(wizard).toContain("sessionStorage.setItem(ONBOARDING_STORAGE_KEY");
    expect(ONBOARDING_STORAGE_KEY).toBe("onboarding_answers");
    expect(wizard.indexOf("המשך עם Google")).toBeLessThan(wizard.indexOf("סיום הרשמה וכניסה לחשבון"));
    expect(wizard).toContain("bg-orange-500 hover:bg-orange-600 text-white font-bold py-3.5 px-6 rounded-xl shadow-lg shadow-orange-500/25");
    expect(wizard).toContain('fetch("/api/register/student"');
    expect(wizard).not.toContain("/portal/dashboard");
  });

  it("keeps terms and WhatsApp consent as separate checkboxes", () => {
    expect(wizard).toContain("אני מסכים/ה לתנאי השימוש ולמדיניות הפרטיות");
    expect(wizard).toContain("אני מסכים/ה לקבל עדכונים בוואטסאפ");
  });

  it("exposes the new auth routes publicly behind the auth rate limit", () => {
    const proxy = readSource("proxy.ts");
    expect(proxy).toMatch(/AUTH_RATE_LIMITED_ROUTES = new Set\(\[[^\]]*"\/api\/register\/student"/);
    for (const route of ["/api/register/student", "/api/auth/google", "/api/auth/google/callback", "/api/auth/google/complete"]) {
      expect(proxy).toContain(`"${route}"`);
    }
  });

  it("uses relative imports only", () => {
    for (const file of [
      "app/register/student/page.tsx",
      "app/auth/callback/page.tsx",
      "app/api/register/student/route.ts",
      "app/api/auth/google/route.ts",
      "app/api/auth/google/callback/route.ts",
      "app/api/auth/google/complete/route.ts",
      "lib/auth/google-oauth.ts",
      "lib/student-onboarding.ts",
      "lib/student-registration.ts",
    ]) {
      expect(readSource(file), file).not.toMatch(/from\s+["']@\//);
    }
  });
});
