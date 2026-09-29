/**
 * Validation for the mapping-call questionnaire (student + parent intake) that a
 * representative records through `POST /api/admin/intake`.
 */

export type IntakeAssessmentFields = {
  // Student intake
  grade: string;
  levelUnits: string;
  hobbies: string;
  isProfessionalHobby: boolean;
  weeklyHobbyFrequency: number | null;
  nextExamDate: Date | null;
  lastExamDate: Date | null;
  lastExamScore: number | null;
  strongTopic: string;
  weakTopic: string;
  focusRequest: string | null;
  mathPerception: string;
  classListening: string;
  pastAssistance: string;
  pastAssistanceDuration: string | null;
  mainGoals: string;
  firstMonthTarget: string;
  studentImportantNotes: string | null;

  // Parent intake
  parentMainGoalYear: string;
  parentTargetScore: number | null;
  parentAverageScore: number | null;
  motivationLevel: string;
  successDefinition: string;
  homeStudyTime: string;
  hasQuietSpace: boolean;
  hasWorkingEquipment: boolean;
  siblingsDetails: string | null;
  learningDisabilities: string | null;
  emotionalDifficulties: string | null;
  pastAssistanceExperience: string | null;
  progressFeltRating: number | null;
  whatWorkedOrFailed: string | null;
  homeLanguage: string | null;
  parentInvolvementLevel: number | null;
  parentImportantNotes: string | null;
  representativeNotes: string | null;
};

export type IntakeAssessmentInput = {
  studentId: string | null;
  fallbackLeadId: string | null;
  fields: IntakeAssessmentFields;
};

export type IntakeParseResult =
  | { ok: true; data: IntakeAssessmentInput }
  | { ok: false; errors: string[] };

const SHORT_TEXT_MAX = 200;
const LONG_TEXT_MAX = 4000;
const ID_MAX = 64;
const MIN_EXAM_YEAR = 2000;
const MAX_EXAM_YEAR = 2100;

const FIELD_LABELS: Record<keyof IntakeAssessmentFields | "studentId" | "fallbackLeadId", string> = {
  studentId: "מזהה תלמיד",
  fallbackLeadId: "מזהה ליד",
  grade: "כיתה",
  levelUnits: "הקבצה / יח״ל",
  hobbies: "תחביבים",
  isProfessionalHobby: "תחביב מקצועי",
  weeklyHobbyFrequency: "תדירות שבועית",
  nextExamDate: "מועד המבחן הבא",
  lastExamDate: "מועד המבחן האחרון",
  lastExamScore: "הציון האחרון",
  strongTopic: "נושא חזק",
  weakTopic: "נושא חלש",
  focusRequest: "נושא למיקוד",
  mathPerception: "בשבילי מתמטיקה היא",
  classListening: "בכיתה אני",
  pastAssistance: "עזרה בעבר",
  pastAssistanceDuration: "משך העזרה",
  mainGoals: "המטרות המרכזיות",
  firstMonthTarget: "יעד החודש הראשון",
  studentImportantNotes: "חשוב לי שתדעו",
  parentMainGoalYear: "המטרה העיקרית השנה",
  parentTargetScore: "ציון היעד",
  parentAverageScore: "ציון ממוצע",
  motivationLevel: "רמת המוטיבציה",
  successDefinition: "מה ייחשב להצלחה",
  homeStudyTime: "זמן למידה בבית",
  hasQuietSpace: "מרחב למידה שקט",
  hasWorkingEquipment: "ציוד תקין",
  siblingsDetails: "אחים ואחיות",
  learningDisabilities: "אבחון לקויות למידה",
  emotionalDifficulties: "קשיים רגשיים",
  pastAssistanceExperience: "שיעורי עזר בעבר",
  progressFeltRating: "הורגשה התקדמות",
  whatWorkedOrFailed: "מה עבד או לא עבד",
  homeLanguage: "שפה מדוברת בבית",
  parentInvolvementLevel: "מעורבות ההורים",
  parentImportantNotes: "דגשים מההורה",
  representativeNotes: "הערות הנציג",
};

type FieldKey = keyof typeof FIELD_LABELS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

class IntakeReader {
  readonly errors: string[] = [];

  constructor(private readonly body: Record<string, unknown>) {}

  private fail(key: FieldKey, reason: string): null {
    this.errors.push(`${FIELD_LABELS[key]}: ${reason}`);
    return null;
  }

  optionalText(key: FieldKey, max = LONG_TEXT_MAX): string | null {
    const value = this.body[key];
    if (isBlank(value)) return null;
    if (typeof value !== "string") return this.fail(key, "צריך להיות טקסט");
    const text = value.trim();
    if (text.length > max) return this.fail(key, `עד ${max} תווים`);
    return text;
  }

  requiredText(key: FieldKey, max = LONG_TEXT_MAX): string {
    if (isBlank(this.body[key])) {
      this.fail(key, "שדה חובה");
      return "";
    }
    return this.optionalText(key, max) ?? "";
  }

  requiredBoolean(key: FieldKey): boolean {
    const value = this.body[key];
    if (typeof value !== "boolean") {
      this.fail(key, "יש לבחור כן או לא");
      return false;
    }
    return value;
  }

  private optionalNumber(key: FieldKey, min: number, max: number, integer: boolean): number | null {
    const value = this.body[key];
    if (isBlank(value)) return null;
    const num = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
    if (!Number.isFinite(num)) return this.fail(key, "צריך להיות מספר");
    if (integer && !Number.isInteger(num)) return this.fail(key, "צריך להיות מספר שלם");
    if (num < min || num > max) return this.fail(key, `בין ${min} ל-${max}`);
    return num;
  }

  optionalInt(key: FieldKey, min: number, max: number): number | null {
    return this.optionalNumber(key, min, max, true);
  }

  optionalFloat(key: FieldKey, min: number, max: number): number | null {
    return this.optionalNumber(key, min, max, false);
  }

  optionalDate(key: FieldKey): Date | null {
    const value = this.body[key];
    if (isBlank(value)) return null;
    if (typeof value !== "string") return this.fail(key, "תאריך לא תקין");
    const date = new Date(value.trim());
    if (Number.isNaN(date.getTime())) return this.fail(key, "תאריך לא תקין");
    const year = date.getUTCFullYear();
    if (year < MIN_EXAM_YEAR || year > MAX_EXAM_YEAR) return this.fail(key, "תאריך לא תקין");
    return date;
  }
}

export function parseIntakeAssessment(body: unknown): IntakeParseResult {
  if (!isRecord(body)) {
    return { ok: false, errors: ["גוף הבקשה חייב להיות אובייקט JSON"] };
  }

  const r = new IntakeReader(body);

  const studentId = r.optionalText("studentId", ID_MAX);
  const fallbackLeadId = r.optionalText("fallbackLeadId", ID_MAX);
  if (!studentId && !fallbackLeadId && r.errors.length === 0) {
    r.errors.push("יש לשייך את השאלון לתלמיד רשום או לליד");
  }

  const fields: IntakeAssessmentFields = {
    grade: r.requiredText("grade", SHORT_TEXT_MAX),
    levelUnits: r.requiredText("levelUnits", SHORT_TEXT_MAX),
    hobbies: r.requiredText("hobbies"),
    isProfessionalHobby: r.requiredBoolean("isProfessionalHobby"),
    weeklyHobbyFrequency: r.optionalInt("weeklyHobbyFrequency", 0, 14),
    nextExamDate: r.optionalDate("nextExamDate"),
    lastExamDate: r.optionalDate("lastExamDate"),
    lastExamScore: r.optionalFloat("lastExamScore", 0, 100),
    strongTopic: r.requiredText("strongTopic"),
    weakTopic: r.requiredText("weakTopic"),
    focusRequest: r.optionalText("focusRequest"),
    mathPerception: r.requiredText("mathPerception"),
    classListening: r.requiredText("classListening"),
    pastAssistance: r.requiredText("pastAssistance"),
    pastAssistanceDuration: r.optionalText("pastAssistanceDuration", SHORT_TEXT_MAX),
    mainGoals: r.requiredText("mainGoals"),
    firstMonthTarget: r.requiredText("firstMonthTarget"),
    studentImportantNotes: r.optionalText("studentImportantNotes"),

    parentMainGoalYear: r.requiredText("parentMainGoalYear"),
    parentTargetScore: r.optionalFloat("parentTargetScore", 0, 100),
    parentAverageScore: r.optionalFloat("parentAverageScore", 0, 100),
    motivationLevel: r.requiredText("motivationLevel"),
    successDefinition: r.requiredText("successDefinition"),
    homeStudyTime: r.requiredText("homeStudyTime"),
    hasQuietSpace: r.requiredBoolean("hasQuietSpace"),
    hasWorkingEquipment: r.requiredBoolean("hasWorkingEquipment"),
    siblingsDetails: r.optionalText("siblingsDetails"),
    learningDisabilities: r.optionalText("learningDisabilities"),
    emotionalDifficulties: r.optionalText("emotionalDifficulties"),
    pastAssistanceExperience: r.optionalText("pastAssistanceExperience"),
    progressFeltRating: r.optionalInt("progressFeltRating", 1, 5),
    whatWorkedOrFailed: r.optionalText("whatWorkedOrFailed"),
    homeLanguage: r.optionalText("homeLanguage", SHORT_TEXT_MAX),
    parentInvolvementLevel: r.optionalInt("parentInvolvementLevel", 1, 5),
    parentImportantNotes: r.optionalText("parentImportantNotes"),
    representativeNotes: r.optionalText("representativeNotes"),
  };

  if (r.errors.length > 0) {
    return { ok: false, errors: r.errors };
  }

  return { ok: true, data: { studentId, fallbackLeadId, fields } };
}
