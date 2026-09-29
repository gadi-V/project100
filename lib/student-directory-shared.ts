import { STUDENT_STATUS_OPTIONS, type StudentStatusCode } from "./student-portal-shared";

/** Client-safe types and parsers for the staff student directory (`/portal/students`). */

export const STUDENT_DIRECTORY_PAGE_SIZE = 25;
export const STUDENT_DIRECTORY_MAX_LIMIT = 100;
const SEARCH_MAX_LENGTH = 80;
const SEARCH_MAX_TOKENS = 5;

export const GRADE_OPTIONS = ["ז׳", "ח׳", "ט׳", "י׳", "יא׳", "יב׳"] as const;
export type GradeOption = (typeof GRADE_OPTIONS)[number];

const GRADE_NUMBERS: Record<GradeOption, number> = {
  "ז׳": 7,
  "ח׳": 8,
  "ט׳": 9,
  "י׳": 10,
  "יא׳": 11,
  "יב׳": 12,
};

/** Quick filter chips on the directory screen ("הכל" = no status filter). */
export const DIRECTORY_STATUS_FILTERS: StudentStatusCode[] = [
  "STUDENT",
  "CALL_BACK_PARENT",
  "BOILING_160",
  "SUBSCRIPTION_CANCELLED",
];

const STATUS_BY_CODE = new Map<string, StudentStatusCode>(STUDENT_STATUS_OPTIONS.map((o) => [o.code, o.code]));
const STATUS_BY_LABEL = new Map<string, StudentStatusCode>(STUDENT_STATUS_OPTIONS.map((o) => [o.label, o.code]));
const ALL_STATUSES = new Set(["ALL", "הכל"]);

export function studentStatusLabel(code: string): string {
  return STUDENT_STATUS_OPTIONS.find((o) => o.code === code)?.label ?? code;
}

export function isGradeOption(value: unknown): value is GradeOption {
  return typeof value === "string" && (GRADE_OPTIONS as readonly string[]).includes(value);
}

/**
 * Spellings of one grade as staff type it in the free-text grade fields:
 * "י׳", "י", "י'", "10", "כיתה י׳"; two-letter grades also as "י״א" / "י\"א".
 */
export function gradeVariants(grade: GradeOption): string[] {
  const base = grade.replace("׳", "");
  const spellings = [base, `${base}׳`, `${base}'`];
  if (base.length === 2) spellings.push(`${base[0]}״${base[1]}`, `${base[0]}"${base[1]}`);
  const number = String(GRADE_NUMBERS[grade]);
  const all = [...spellings, number, ...[...spellings, number].map((s) => `כיתה ${s}`)];
  return Array.from(new Set(all));
}

export type StudentDirectoryQuery = {
  search: string;
  /** Whitespace-separated search terms; each must match one of the searchable fields. */
  searchTokens: string[];
  statuses: StudentStatusCode[];
  grade: GradeOption | null;
  page: number;
  limit: number;
};

type ParseResult<T> = { ok: true; data: T } | { ok: false; errors: string[] };

function positiveInt(value: string | null, fallback: number): number {
  if (value === null || !/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value.trim());
  return parsed >= 1 ? parsed : fallback;
}

/**
 * Query string of `GET /api/portal/students`.
 * `status` may repeat or be comma-separated, as codes (`BOILING_160`) or labels (`רותח 160`).
 * Missing or malformed `page` / `limit` fall back to 1 / 25; `limit` is capped at 100.
 */
export function parseStudentDirectoryQuery(params: URLSearchParams): ParseResult<StudentDirectoryQuery> {
  const errors: string[] = [];

  const search = (params.get("search") ?? "").trim().replace(/\s+/g, " ").slice(0, SEARCH_MAX_LENGTH);
  const searchTokens = search ? search.split(" ").slice(0, SEARCH_MAX_TOKENS) : [];

  const statuses: StudentStatusCode[] = [];
  const rawStatuses = params
    .getAll("status")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value && !ALL_STATUSES.has(value));
  for (const raw of rawStatuses) {
    const code = STATUS_BY_CODE.get(raw) ?? STATUS_BY_LABEL.get(raw);
    if (!code) {
      errors.push(`סטטוס לא מוכר: ${raw}`);
      continue;
    }
    if (!statuses.includes(code)) statuses.push(code);
  }

  const rawGrade = (params.get("grade") ?? "").trim();
  let grade: GradeOption | null = null;
  if (rawGrade) {
    if (isGradeOption(rawGrade)) grade = rawGrade;
    else errors.push(`כיתה לא מוכרת: ${rawGrade}`);
  }

  const page = positiveInt(params.get("page"), 1);
  const limit = Math.min(positiveInt(params.get("limit"), STUDENT_DIRECTORY_PAGE_SIZE), STUDENT_DIRECTORY_MAX_LIMIT);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, data: { search, searchTokens, statuses, grade, page, limit } };
}

export type PaginationMeta = {
  totalCount: number;
  page: number;
  limit: number;
  totalPages: number;
};

/** Page numbers are 1-based; a page past the end is pulled back to the last page. */
export function paginationMeta(totalCount: number, requestedPage: number, limit: number): PaginationMeta & { skip: number } {
  const safeLimit = Math.max(1, Math.floor(limit));
  const totalPages = Math.max(1, Math.ceil(Math.max(0, totalCount) / safeLimit));
  const page = Math.min(Math.max(1, Math.floor(requestedPage)), totalPages);
  return { totalCount: Math.max(0, totalCount), page, limit: safeLimit, totalPages, skip: (page - 1) * safeLimit };
}

export type StudentDirectoryRow = {
  id: string;
  fullName: string;
  phone: string;
  whatsappUrl: string | null;
  grade: string | null;
  studyGroup: string | null;
  city: string | null;
  statuses: string[];
  nextLessonAt: string | null;
  lastLessonAt: string | null;
  /** Teacher of the next lesson, else of the latest one. */
  teacherName: string | null;
};

export type StudentDirectoryPage = PaginationMeta & {
  students: StudentDirectoryRow[];
};
