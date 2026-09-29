import type { Role } from "@prisma/client";

/**
 * Summary templates for the student communication tab (`/portal/students/[id]`).
 * The editable text is the source of truth: `renderCommunicationTemplate` fills the modal, and
 * `parseCommunicationInput` (browser and `POST /api/portal/students/[id]/communication`) reads the
 * labelled lines back into `structuredData` and validates choices, scores and required lines.
 */

export const COMMUNICATION_TYPES = [
  "POST_MAPPING_CALL",
  "LESSON_SUMMARY",
  "MAPPING_SUMMARY",
  "GENERAL",
] as const;

export type CommunicationType = (typeof COMMUNICATION_TYPES)[number];

export const COMMUNICATION_TYPE_LABELS: Record<CommunicationType, string> = {
  POST_MAPPING_CALL: "סיכום שיחה לאחר מיפוי",
  LESSON_SUMMARY: "סיכום שיעור",
  MAPPING_SUMMARY: "סיכום מיפוי",
  GENERAL: "כללי",
};

/** Staff roles that may write on the communication tab at all. */
export const COMMUNICATION_AUTHOR_ROLES: Role[] = ["TEACHER", "REPRESENTATIVE", "ADMIN", "MANAGER"];

/** Who may record each summary type. MANAGER is the pedagogic manager. */
export const COMMUNICATION_TYPE_ROLES: Record<CommunicationType, readonly Role[]> = {
  POST_MAPPING_CALL: ["REPRESENTATIVE", "MANAGER", "ADMIN"],
  LESSON_SUMMARY: ["TEACHER", "MANAGER", "ADMIN"],
  MAPPING_SUMMARY: ["TEACHER", "MANAGER", "ADMIN"],
  GENERAL: ["TEACHER", "REPRESENTATIVE", "MANAGER", "ADMIN"],
};

export type CommunicationAuthorRole = "TEACHER" | "REPRESENTATIVE" | "ADMIN" | "PEDAGOGIC_MANAGER";

export const COMMUNICATION_AUTHOR_ROLE_LABELS: Record<CommunicationAuthorRole, string> = {
  TEACHER: "מורה",
  REPRESENTATIVE: "נציג/ה",
  ADMIN: "הנהלה",
  PEDAGOGIC_MANAGER: "מנהל/ת פדגוגי/ת",
};

export function isCommunicationType(value: unknown): value is CommunicationType {
  return typeof value === "string" && (COMMUNICATION_TYPES as readonly string[]).includes(value);
}

export function canWriteCommunicationType(role: string, type: CommunicationType): boolean {
  return (COMMUNICATION_TYPE_ROLES[type] as readonly string[]).includes(role);
}

export function allowedCommunicationTypes(role: string): CommunicationType[] {
  return COMMUNICATION_TYPES.filter((type) => canWriteCommunicationType(role, type));
}

/** Stored `authorRole`; returns null for roles that may not write summaries. */
export function toCommunicationAuthorRole(role: string): CommunicationAuthorRole | null {
  if (role === "MANAGER") return "PEDAGOGIC_MANAGER";
  if (role === "TEACHER" || role === "REPRESENTATIVE" || role === "ADMIN") return role;
  return null;
}

export type TemplateFieldKind = "text" | "choice" | "score" | "list";

export type TemplateField = {
  key: string;
  label: string;
  kind: TemplateFieldKind;
  options?: readonly string[];
  /** Printed in parentheses after the label, e.g. "(0-100)". */
  hint?: string;
  required?: boolean;
  /** Numbered lines under a list field. */
  listSize?: number;
};

export type CommunicationTemplate = {
  type: Exclude<CommunicationType, "GENERAL">;
  label: string;
  audience: string;
  /** Lines start with "* " (lesson summary). */
  bulleted?: boolean;
  fields: readonly TemplateField[];
};

const LEVEL_F = ["גבוהה", "בינונית", "נמוכה"] as const;
const LEVEL_M = ["גבוה", "בינוני", "נמוך"] as const;
const SUBSCRIPTION = ["חד שבועי", "דו שבועי"] as const;

export const COMMUNICATION_TEMPLATES: Record<CommunicationTemplate["type"], CommunicationTemplate> = {
  POST_MAPPING_CALL: {
    type: "POST_MAPPING_CALL",
    label: COMMUNICATION_TYPE_LABELS.POST_MAPPING_CALL,
    audience: "מנהל/ת פדגוגי/ת או נציג/ה",
    fields: [
      { key: "background", label: "רקע", kind: "text" },
      { key: "personalNotes", label: "דגשים אישיים", kind: "text" },
      { key: "learningNotes", label: "דגשים לימודיים", kind: "text" },
      { key: "mainGoal", label: "מטרה מרכזית", kind: "text", required: true },
      { key: "parentType", label: "סוג הורה", kind: "choice", options: ["אדיש", "מעורב", "מתערב"], required: true },
      { key: "subscriptionType", label: "סוג המנוי", kind: "choice", options: SUBSCRIPTION, required: true },
      { key: "professionalManagerInvolvement", label: "מעורבות מנהל מקצועי", kind: "text" },
      { key: "schedule", label: "ימים ושעות", kind: "text" },
      { key: "extraPrivateLessons", label: "תוספת ש.פ", kind: "choice", options: ["1", "2", "אין"] },
    ],
  },
  LESSON_SUMMARY: {
    type: "LESSON_SUMMARY",
    label: COMMUNICATION_TYPE_LABELS.LESSON_SUMMARY,
    audience: "מורה",
    bulleted: true,
    fields: [
      { key: "workedOn", label: "עבדנו על", kind: "text", required: true },
      { key: "homework", label: "כשיעורי בית", kind: "text" },
      { key: "nextLesson", label: "שיעור הבא", kind: "text" },
    ],
  },
  MAPPING_SUMMARY: {
    type: "MAPPING_SUMMARY",
    label: COMMUNICATION_TYPE_LABELS.MAPPING_SUMMARY,
    audience: "מורה ממפה",
    fields: [
      { key: "gradeAndGroup", label: "כיתה והקבצה", kind: "text", required: true },
      { key: "lastSchoolScore", label: "ציון אחרון בביה״ס", kind: "score", hint: "0-100" },
      { key: "classLearning", label: "למידה בכיתה בביה״ס", kind: "choice", options: LEVEL_F },
      {
        key: "homeLearning",
        label: "למידה בבית",
        kind: "choice",
        options: [...LEVEL_F, "בכלל לא", "רק לפני מבחן"],
      },
      { key: "motivation", label: "מוטיבציה", kind: "choice", options: LEVEL_F },
      { key: "personalConnection", label: "חיבור אישי", kind: "choice", options: LEVEL_M },
      { key: "topicRanking", label: "דירוג הנושאים", kind: "list", hint: "נושא וציון", listSize: 4 },
      { key: "mainGoal", label: "מטרה מרכזית", kind: "text", required: true },
      {
        key: "formatFit",
        label: "התאמה לפורמט",
        kind: "choice",
        options: ["מתאים", "ש.פ במקביל", "ש.פ לפני", "2 ש.פ לפני", "לא מתאים"],
        required: true,
      },
      { key: "subscriptionRecommendation", label: "המלצה למנוי", kind: "choice", options: SUBSCRIPTION, required: true },
      { key: "additionalNotes", label: "הערות נוספות", kind: "text" },
    ],
  },
};

export function getCommunicationTemplate(type: CommunicationType): CommunicationTemplate | null {
  return type === "GENERAL" ? null : COMMUNICATION_TEMPLATES[type];
}

function fieldHeading(template: CommunicationTemplate, field: TemplateField): string {
  const bullet = template.bulleted ? "* " : "";
  const hint = field.hint ? ` (${field.hint})` : "";
  return `${bullet}${field.label}${hint}:`;
}

/** Blank template text loaded into the summary modal. GENERAL starts empty. */
export function renderCommunicationTemplate(type: CommunicationType): string {
  const template = getCommunicationTemplate(type);
  if (!template) return "";
  const lines: string[] = [];
  for (const field of template.fields) {
    lines.push(`${fieldHeading(template, field)} `);
    if (field.kind === "list") {
      for (let i = 1; i <= (field.listSize ?? 0); i++) lines.push(`${i}. `);
    }
  }
  return lines.join("\n");
}

/** Hebrew text mixes ״/" and ׳/' freely; compare labels and choices on one form. */
function normalizeText(value: string): string {
  return value.replace(/[״"]/g, '"').replace(/[׳']/g, "'").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function headingPattern(field: TemplateField): RegExp {
  return new RegExp(`^\\*?\\s*${escapeRegExp(normalizeText(field.label))}\\s*(?:\\([^)]*\\))?\\s*:\\s*(.*)$`);
}

const LIST_ITEM = /^\s*(\d+)\s*[.)]\s*(.*)$/;

export type RankedTopic = { rank: number; topic: string; score: number | null };
export type StructuredValue = string | number | RankedTopic[] | null;
export type CommunicationStructuredData = {
  template: Exclude<CommunicationType, "GENERAL">;
  fields: Record<string, StructuredValue>;
};

function parseRankedTopic(rank: number, text: string): RankedTopic {
  const match = /^(.*?)[\s\-–:,]+(\d{1,3})$/.exec(text);
  if (match && match[1].trim() && Number(match[2]) <= 100) {
    return { rank, topic: match[1].trim(), score: Number(match[2]) };
  }
  return { rank, topic: text, score: null };
}

type TemplateParseResult =
  | { ok: true; structuredData: CommunicationStructuredData }
  | { ok: false; errors: string[] };

/** Reads labelled lines (multi-line values allowed) back into template fields and validates them. */
export function parseTemplateContent(type: CommunicationType, content: string): TemplateParseResult | null {
  const template = getCommunicationTemplate(type);
  if (!template) return null;

  const patterns = template.fields.map((field) => ({ field, pattern: headingPattern(field) }));
  const textValues = new Map<string, string[]>();
  const listValues = new Map<string, RankedTopic[]>();
  let current: TemplateField | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = normalizeText(rawLine);
    const heading = patterns.find(({ pattern }) => pattern.test(line));
    if (heading) {
      current = heading.field;
      const rest = heading.pattern.exec(line)?.[1]?.trim() ?? "";
      if (current.kind !== "list") textValues.set(current.key, rest ? [rawLine.slice(rawLine.indexOf(":") + 1).trim()] : []);
      else listValues.set(current.key, []);
      continue;
    }
    if (!current || !line) continue;
    if (current.kind === "list") {
      const item = LIST_ITEM.exec(rawLine);
      if (item) {
        const text = item[2].trim();
        if (text) listValues.get(current.key)?.push(parseRankedTopic(Number(item[1]), text));
        continue;
      }
    }
    if (current.kind !== "list") textValues.get(current.key)?.push(rawLine.trim());
  }

  const errors: string[] = [];
  const fields: Record<string, StructuredValue> = {};

  for (const field of template.fields) {
    if (field.kind === "list") {
      const items = listValues.get(field.key) ?? [];
      fields[field.key] = items;
      if (field.required && items.length === 0) errors.push(`חסר: ${field.label}`);
      continue;
    }

    const value = (textValues.get(field.key) ?? []).join("\n").trim();
    if (!value) {
      fields[field.key] = null;
      if (field.required) errors.push(`חסר: ${field.label}`);
      continue;
    }

    if (field.kind === "choice") {
      const option = field.options?.find((o) => normalizeText(o) === normalizeText(value));
      if (!option) {
        errors.push(`${field.label}: בחרו אחת מהאפשרויות ${field.options?.join(" / ")}`);
        fields[field.key] = null;
      } else {
        fields[field.key] = option;
      }
      continue;
    }

    if (field.kind === "score") {
      const score = Number(value);
      if (!Number.isFinite(score) || score < 0 || score > 100) {
        errors.push(`${field.label}: ציון בין 0 ל-100`);
        fields[field.key] = null;
      } else {
        fields[field.key] = score;
      }
      continue;
    }

    fields[field.key] = value;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, structuredData: { template: template.type, fields } };
}

/** Sets one template line (used by the quick-choice buttons in the modal). Appends it when missing. */
export function setTemplateFieldValue(
  content: string,
  type: CommunicationType,
  fieldKey: string,
  value: string
): string {
  const template = getCommunicationTemplate(type);
  const field = template?.fields.find((f) => f.key === fieldKey);
  if (!template || !field || field.kind === "list") return content;

  const pattern = headingPattern(field);
  const nextLine = `${fieldHeading(template, field)} ${value}`;
  const lines = content.split(/\r?\n/);
  const index = lines.findIndex((line) => pattern.test(normalizeText(line)));
  if (index === -1) return content ? `${content}\n${nextLine}` : nextLine;
  lines[index] = nextLine;
  return lines.join("\n");
}

export const COMMUNICATION_CONTENT_MAX = 10_000;
export const COURSE_CONTEXT_MAX = 200;

export type CommunicationInput = {
  type: CommunicationType;
  content: string;
  courseContext: string | null;
  structuredData: CommunicationStructuredData | null;
};

export type CommunicationInputResult =
  | { ok: true; data: CommunicationInput }
  | { ok: false; errors: string[] };

/** Validates the save request body. Author fields always come from the session, never from here. */
export function parseCommunicationInput(body: unknown): CommunicationInputResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: ["גוף הבקשה חסר"] };
  }
  const record = body as Record<string, unknown>;
  const errors: string[] = [];

  const type = record.type;
  if (!isCommunicationType(type)) {
    return { ok: false, errors: ["סוג הסיכום אינו מוכר"] };
  }

  const content = typeof record.content === "string" ? record.content.trim() : "";
  if (!content) errors.push("התוכן ריק");
  if (content.length > COMMUNICATION_CONTENT_MAX) {
    errors.push(`התוכן ארוך מדי (עד ${COMMUNICATION_CONTENT_MAX.toLocaleString("he-IL")} תווים)`);
  }

  let courseContext: string | null = null;
  if (record.courseContext != null) {
    if (typeof record.courseContext !== "string") errors.push("הקשר / קורס חייב להיות טקסט");
    else {
      courseContext = record.courseContext.trim() || null;
      if (courseContext && courseContext.length > COURSE_CONTEXT_MAX) {
        errors.push(`הקשר / קורס ארוך מדי (עד ${COURSE_CONTEXT_MAX} תווים)`);
      }
    }
  }

  let structuredData: CommunicationStructuredData | null = null;
  if (content) {
    const parsed = parseTemplateContent(type, content);
    if (parsed && !parsed.ok) errors.push(...parsed.errors);
    if (parsed?.ok) structuredData = parsed.structuredData;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, data: { type, content, courseContext, structuredData } };
}
