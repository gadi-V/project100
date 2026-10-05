import { InvalidPhoneNumberError, normalizeToE164 } from "./utils/phone";

/** sessionStorage key that carries wizard steps 1-3 across the Google OAuth round trip. */
export const ONBOARDING_STORAGE_KEY = "onboarding_answers";

export type StudyPath = "school" | "academia";

/** Answers collected in steps 1-3 of the student registration wizard. */
export type OnboardingAnswers = {
  path: StudyPath;
  schoolGrade: string;
  schoolUnits: string;
  schoolSubject: string;
  academicInstitution: string;
  academicDegree: string;
  academicCourse: string;
  bottleneck: string;
  goalType: string;
};

export const BOTTLENECK_LABELS: Record<string, string> = {
  gaps: "פערי עבר קשים בבסיס של חומר הלימוד",
  anxiety: 'חרדת בחינות, לחץ מנטלי בלייב או "בלקאאוט" במבחן',
  discipline: "קושי בניהול זמן, חוסר משמעת עצמית או קושי בתרגול עצמאי",
};

export const GOAL_LABELS: Record<string, string> = {
  marathon: "מרתון ממוקד בטווח הקצר",
  semester: "ליווי סמסטריאלי / שנתי שוטף",
};

const MAX_TEXT = 120;

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function text(value: unknown, max = MAX_TEXT): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function parseOnboardingAnswers(raw: unknown): ParseResult<OnboardingAnswers> {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "יש להשלים את שלבי האבחון לפני הרישום" };
  }
  const b = raw as Record<string, unknown>;
  const path = b.path === "school" || b.path === "academia" ? b.path : null;
  if (!path) return { ok: false, error: "יש לבחור מסלול לימודים" };

  const answers: OnboardingAnswers = {
    path,
    schoolGrade: path === "school" ? text(b.schoolGrade) : "",
    schoolUnits: path === "school" && ["3", "4", "5"].includes(text(b.schoolUnits)) ? text(b.schoolUnits) : "",
    schoolSubject: path === "school" ? text(b.schoolSubject) : "",
    academicInstitution: path === "academia" ? text(b.academicInstitution) : "",
    academicDegree: path === "academia" ? text(b.academicDegree) : "",
    academicCourse: path === "academia" ? text(b.academicCourse) : "",
    bottleneck: text(b.bottleneck, 40),
    goalType: text(b.goalType, 40),
  };

  if (path === "school" && !answers.schoolGrade) {
    return { ok: false, error: "יש למלא את כיתת הלימוד" };
  }
  if (path === "academia" && !answers.academicCourse) {
    return { ok: false, error: "יש למלא את שם הקורס" };
  }
  if (!BOTTLENECK_LABELS[answers.bottleneck] || !GOAL_LABELS[answers.goalType]) {
    return { ok: false, error: "יש להשלים את האתגר ואת מסגרת הליווי" };
  }
  return { ok: true, value: answers };
}

/**
 * Israeli mobile number in the local format stored on `User.phone` (`0501234567`),
 * which is what students type on the login screen. Returns null for anything else.
 */
export function normalizeIsraeliMobile(raw: string): string | null {
  try {
    const e164 = normalizeToE164(raw);
    const national = e164.startsWith("+972") ? e164.slice(4) : "";
    return /^5\d{8}$/.test(national) ? `0${national}` : null;
  } catch (error) {
    if (error instanceof InvalidPhoneNumberError) return null;
    throw error;
  }
}

export const INVALID_PHONE_ERROR = "יש להזין מספר נייד ישראלי תקין, למשל 050-1234567";

/** Field values written to `User`, `StudentProfile` and `DiagnosticQuiz` for one set of answers. */
export function buildStudentRecords(answers: OnboardingAnswers) {
  const units = answers.schoolUnits ? `${answers.schoolUnits} יח״ל` : null;
  const meta = {
    path: answers.path,
    bottleneck: answers.bottleneck,
    bottleneckLabel: BOTTLENECK_LABELS[answers.bottleneck],
    goalType: answers.goalType,
    goalLabel: GOAL_LABELS[answers.goalType],
  };

  if (answers.path === "school") {
    return {
      user: { trackType: "BAGRUT", classTrack: units, schoolName: null, degreeField: null },
      profile: { grade: answers.schoolGrade, studyGroup: units },
      diagnostic: {
        ageGroup: `בית ספר - ${answers.schoolGrade}`,
        subject: answers.schoolSubject || "לא צוין",
        challenge: JSON.stringify({
          ...meta,
          schoolGrade: answers.schoolGrade,
          schoolUnits: answers.schoolUnits,
        }),
      },
    };
  }

  return {
    user: {
      trackType: "ACADEMIC",
      classTrack: null,
      schoolName: answers.academicInstitution || null,
      degreeField: answers.academicDegree || null,
    },
    profile: { grade: null, studyGroup: null },
    diagnostic: {
      ageGroup: "אקדמיה / סטודנט",
      subject: answers.academicCourse,
      challenge: JSON.stringify({
        ...meta,
        academicInstitution: answers.academicInstitution,
        academicDegree: answers.academicDegree,
      }),
    },
  };
}

export type StudentSignupInput = {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  password: string;
  whatsappUpdates: boolean;
  answers: OnboardingAnswers;
};

/** Validates the manual sign-up form (step 4) together with the step 1-3 answers. */
export function parseStudentSignup(raw: unknown): ParseResult<StudentSignupInput> {
  if (!raw || typeof raw !== "object") return { ok: false, error: "בקשה לא תקינה" };
  const b = raw as Record<string, unknown>;

  const firstName = text(b.firstName, 60);
  const lastName = text(b.lastName, 60);
  if (!firstName || !lastName) return { ok: false, error: "יש למלא שם פרטי ושם משפחה" };

  const phone = normalizeIsraeliMobile(text(b.phone, 40));
  if (!phone) return { ok: false, error: INVALID_PHONE_ERROR };

  const email = text(b.email, 254);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "יש להזין כתובת אימייל תקינה" };
  }

  const password = typeof b.password === "string" ? b.password : "";
  if (password.length < 6) return { ok: false, error: "הסיסמה צריכה להכיל לפחות 6 תווים" };

  if (b.acceptTerms !== true) {
    return { ok: false, error: "יש לאשר את תנאי השימוש ומדיניות הפרטיות" };
  }

  const answers = parseOnboardingAnswers(b.answers);
  if (!answers.ok) return answers;

  return {
    ok: true,
    value: {
      firstName,
      lastName,
      phone,
      email,
      password,
      whatsappUpdates: b.whatsappUpdates === true,
      answers: answers.value,
    },
  };
}
