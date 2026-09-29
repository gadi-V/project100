import type { IntakeAssessmentFields } from "./intake-assessment";

/**
 * Form model for the representative's mapping-call screen (`/portal/intake`).
 * Every value is kept as a string while editing; `buildIntakePayload` converts it to the
 * `POST /api/admin/intake` body, which is validated again by `parseIntakeAssessment`.
 */

export type YesNo = "" | "yes" | "no";

type BooleanKey = {
  [K in keyof IntakeAssessmentFields]: IntakeAssessmentFields[K] extends boolean ? K : never;
}[keyof IntakeAssessmentFields];

export type IntakeFormState = {
  [K in keyof IntakeAssessmentFields]: K extends BooleanKey ? YesNo : string;
};

export type IntakeFieldKey = keyof IntakeFormState;

export type IntakeFieldKind = "text" | "textarea" | "number" | "date" | "yesno" | "rating";

export type IntakeFieldDef = {
  key: IntakeFieldKey;
  label: string;
  kind: IntakeFieldKind;
  required?: boolean;
  placeholder?: string;
  suggestions?: readonly string[];
  min?: number;
  max?: number;
  step?: number;
};

export type IntakeTarget = { kind: "LEAD" | "STUDENT"; id: string };

export const INTAKE_KIND_LABELS: Record<IntakeTarget["kind"], string> = {
  LEAD: "ליד מהאתר",
  STUDENT: "תלמיד/ה רשום/ה",
};

const israelDate = new Intl.DateTimeFormat("he-IL", {
  timeZone: "Asia/Jerusalem",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

export function formatIsraelDate(iso: string): string {
  return israelDate.format(new Date(iso));
}

export const STUDENT_INTAKE_FIELDS: readonly IntakeFieldDef[] = [
  { key: "grade", label: "כיתה", kind: "text", required: true, suggestions: ["ז", "ח", "ט", "י", "יא", "יב"] },
  { key: "levelUnits", label: "הקבצה / יח״ל", kind: "text", required: true, suggestions: ["3 יח״ל", "4 יח״ל", "5 יח״ל", "הקבצה א", "הקבצה ב"] },
  { key: "hobbies", label: "תחביבים", kind: "text", required: true, placeholder: "למשל: מחשבים ולחימה" },
  { key: "isProfessionalHobby", label: "באופן מקצועי?", kind: "yesno", required: true },
  { key: "weeklyHobbyFrequency", label: "כמה פעמים בשבוע?", kind: "number", min: 0, max: 14, step: 1 },
  { key: "nextExamDate", label: "מתי המבחן הבא?", kind: "date" },
  { key: "lastExamDate", label: "מתי היה המבחן האחרון?", kind: "date" },
  { key: "lastExamScore", label: "מה היה הציון האחרון?", kind: "number", min: 0, max: 100, step: 0.5 },
  { key: "strongTopic", label: "נושא חזק", kind: "text", required: true, placeholder: "למשל: אלגברה" },
  { key: "weakTopic", label: "נושא חלש", kind: "text", required: true, placeholder: "למשל: גיאומטריה" },
  { key: "focusRequest", label: "משהו שתרצה שנתמקד בו?", kind: "text" },
  { key: "mathPerception", label: "בשבילי מתמטיקה היא", kind: "text", required: true, suggestions: ["מאתגרת", "מהנה", "משעממת", "מלחיצה"] },
  { key: "classListening", label: "בכיתה אני", kind: "text", required: true, suggestions: ["בהקשבה מלאה", "מקשיב/ה חלקית", "מתקשה להתרכז"] },
  { key: "pastAssistance", label: "האם קיבלתי עזרה בעבר?", kind: "text", required: true, suggestions: ["לא", "שיעורים פרטיים", "תגבור בבית הספר", "מכון"] },
  { key: "pastAssistanceDuration", label: "כמה זמן?", kind: "text", suggestions: ["פחות מחודש", "כמה חודשים", "מעל שנה"] },
  { key: "mainGoals", label: "המטרות המרכזיות שלי", kind: "textarea", required: true },
  { key: "firstMonthTarget", label: "יעד החודש הראשון", kind: "textarea", required: true },
  { key: "studentImportantNotes", label: "חשוב לי שתדעו", kind: "textarea" },
];

export const PARENT_INTAKE_FIELDS: readonly IntakeFieldDef[] = [
  { key: "parentMainGoalYear", label: "מהי המטרה העיקרית השנה?", kind: "textarea", required: true },
  { key: "parentTargetScore", label: "לאיזה ציון תרצו להגיע?", kind: "number", min: 0, max: 100, step: 1 },
  { key: "parentAverageScore", label: "ציון ממוצע", kind: "number", min: 0, max: 100, step: 1 },
  { key: "motivationLevel", label: "מה רמת המוטיבציה?", kind: "text", required: true, suggestions: ["גבוהה", "בינונית", "נמוכה"] },
  { key: "successDefinition", label: "מה ייחשב להצלחה בעיניכם?", kind: "textarea", required: true },
  { key: "homeStudyTime", label: "כמה זמן מוקדש ללמידה בבית?", kind: "text", required: true, suggestions: ["כמעט לא", "עד שעה בשבוע", "1–3 שעות בשבוע", "מעל 3 שעות בשבוע"] },
  { key: "hasQuietSpace", label: "יש מרחב למידה שקט?", kind: "yesno", required: true },
  { key: "hasWorkingEquipment", label: "אינטרנט, מיקרופון ומצלמה תקינים?", kind: "yesno", required: true },
  { key: "siblingsDetails", label: "אחים או אחיות, ובאילו גילאים", kind: "text" },
  { key: "learningDisabilities", label: "יש אבחון לקויות למידה?", kind: "text" },
  { key: "emotionalDifficulties", label: "יש קשיים רגשיים שקשורים ללמידה?", kind: "text" },
  { key: "pastAssistanceExperience", label: "שיעורי עזר בעבר", kind: "text" },
  { key: "progressFeltRating", label: "הורגשה התקדמות? (1–5)", kind: "rating" },
  { key: "whatWorkedOrFailed", label: "מה עבד או לא עבד במסגרת הקודמת?", kind: "textarea" },
  { key: "homeLanguage", label: "שפה מדוברת בבית", kind: "text", suggestions: ["עברית", "ערבית", "רוסית", "אנגלית", "אמהרית", "צרפתית"] },
  { key: "parentInvolvementLevel", label: "עד כמה תהיו מעורבים בלמידה? (1–5)", kind: "rating" },
  { key: "parentImportantNotes", label: "דגשים חשובים מההורה", kind: "textarea" },
  { key: "representativeNotes", label: "הערות הנציג", kind: "textarea" },
];

export const EMPTY_INTAKE_FORM: IntakeFormState = Object.fromEntries(
  [...STUDENT_INTAKE_FIELDS, ...PARENT_INTAKE_FIELDS].map((field) => [field.key, ""])
) as IntakeFormState;

function toBoolean(value: YesNo): boolean | undefined {
  if (value === "yes") return true;
  if (value === "no") return false;
  return undefined;
}

/** Numbers go out as numbers; anything unparseable is sent as-is so the validator reports it. */
function toNumber(value: string): number | string | null {
  const text = value.trim();
  if (!text) return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : text;
}

function toText(value: string): string | null {
  const text = value.trim();
  return text ? text : null;
}

export function buildIntakePayload(
  form: IntakeFormState,
  target: IntakeTarget
): Record<string, unknown> {
  const payload: Record<string, unknown> = target.kind === "STUDENT"
    ? { studentId: target.id }
    : { fallbackLeadId: target.id };

  for (const field of [...STUDENT_INTAKE_FIELDS, ...PARENT_INTAKE_FIELDS]) {
    const raw = form[field.key];
    switch (field.kind) {
      case "yesno":
        payload[field.key] = toBoolean(raw as YesNo);
        break;
      case "number":
      case "rating":
        payload[field.key] = toNumber(raw);
        break;
      default:
        payload[field.key] = toText(raw);
    }
  }

  return payload;
}
