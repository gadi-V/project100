import { InvalidPhoneNumberError, normalizeToE164 } from "./utils/phone";

/**
 * Teacher job applications from the public `/careers` page. Stored as AuditLog rows for
 * management review; an application never creates a User or TeacherProfile.
 */

export const TEACHER_CANDIDATE_ACTION = "TEACHER_CANDIDATE_APPLIED";
export const TEACHER_CANDIDATE_ENTITY = "TeacherCandidate";

export const TEACHING_FRAMEWORKS = {
  SCHOOL: "בתי ספר",
  INSTITUTE: "מכונים ומרכזי למידה",
  PRIVATE: "שיעורים פרטיים",
  ACADEMIA: "אקדמיה",
  OTHER: "אחר",
} as const;

export type TeachingFramework = keyof typeof TEACHING_FRAMEWORKS;

export type TeacherCandidateApplication = {
  fullName: string;
  /** E.164 (`+972541234567`). */
  phone: string;
  email: string;
  education: string;
  yearsOfExperience: number;
  teachingFrameworks: TeachingFramework[];
  previousInstitutions: string;
  subjects: string[];
  cvUrl: string;
};

export type TeacherCandidateParseResult =
  | { ok: true; data: TeacherCandidateApplication }
  | { ok: false; error: string };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_SUBJECTS = 15;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function parseSubjects(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,،\n]/) : [];
  const subjects = raw
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim().slice(0, 60))
    .filter(Boolean);
  return Array.from(new Set(subjects)).slice(0, MAX_SUBJECTS);
}

function parseFrameworks(value: unknown): TeachingFramework[] {
  if (!Array.isArray(value)) return [];
  const valid = value.filter(
    (f): f is TeachingFramework => typeof f === "string" && f in TEACHING_FRAMEWORKS
  );
  return Array.from(new Set(valid));
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function parseTeacherCandidateApplication(body: unknown): TeacherCandidateParseResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "גוף הבקשה חייב להיות אובייקט JSON" };
  }
  const b = body as Record<string, unknown>;

  const fullName = text(b.fullName, 120);
  if (fullName.length < 2) return { ok: false, error: "נא למלא שם מלא" };

  let phone: string;
  try {
    phone = normalizeToE164(text(b.phone, 40));
  } catch (error) {
    if (error instanceof InvalidPhoneNumberError) {
      return { ok: false, error: "מספר הטלפון אינו תקין" };
    }
    throw error;
  }

  const email = text(b.email, 200).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) return { ok: false, error: "כתובת האימייל אינה תקינה" };

  const education = text(b.education, 500);
  if (!education) return { ok: false, error: "נא לפרט השכלה ותואר" };

  const years = typeof b.yearsOfExperience === "string" ? Number(b.yearsOfExperience) : b.yearsOfExperience;
  if (typeof years !== "number" || !Number.isInteger(years) || years < 0 || years > 60) {
    return { ok: false, error: "שנות ניסיון: מספר שלם בין 0 ל-60" };
  }

  const teachingFrameworks = parseFrameworks(b.teachingFrameworks);
  if (teachingFrameworks.length === 0) {
    return { ok: false, error: "נא לסמן לפחות מסגרת הוראה אחת" };
  }

  const previousInstitutions = text(b.previousInstitutions, 2000);

  const subjects = parseSubjects(b.subjects);
  if (subjects.length === 0) return { ok: false, error: "נא לציין לפחות מקצוע אחד" };

  const cvUrl = text(b.cvUrl, 1000);
  if (!isHttpsUrl(cvUrl)) {
    return { ok: false, error: "נא לצרף קישור https לקורות החיים" };
  }

  return {
    ok: true,
    data: {
      fullName,
      phone,
      email,
      education,
      yearsOfExperience: years,
      teachingFrameworks,
      previousInstitutions,
      subjects,
      cvUrl,
    },
  };
}
