/**
 * Shared anti-bypass censorship for in-app chat (client + server alignment).
 * Never expose phone numbers, emails, external links or social handles
 * between Teachers and Students.
 */

export type ChatViolation = "phone" | "email" | "external_link" | "social_handle";

export type ChatModerationResult = {
  isClean: boolean;
  censoredText: string;
  detectedViolations: ChatViolation[];
};

/** Separators used to obfuscate numbers: spaces, dots, dashes, parentheses. */
const SEP = "[\\s.\\-()]*";
const digitRun = (min: number) => `(?:${SEP}\\d){${min},}`;
/** Reject matches glued to more digits or to a clock time (`2026 10:30`). */
const END = "(?!\\d|:\\d)";
/** Israeli national number: mobile/VoIP 5X/7X (9 digits) or landline (8 digits). */
const IL_NATIONAL = `(?:[57]${digitRun(8)}|[2-489]${digitRun(7)})`;

/*
 * No lookbehind: this module ships to the browser (ClassroomChat) and must load
 * on Safari < 16.4. Regexes needing a left boundary capture it as group 1
 * (`lead`) and the replacer puts it back.
 */
export const PHONE_REGEX = new RegExp(
  `(^|\\D)(?:${[
    `(?:\\+|00)${SEP}972${SEP}(?:0${SEP})?${IL_NATIONAL}${END}`,
    `972${SEP}(?:0${SEP})?${IL_NATIONAL}${END}`,
    `\\(?0${SEP}${IL_NATIONAL}${END}`,
    `\\+\\d${digitRun(7)}${END}`,
    `\\d{9,}`,
  ].join("|")})`,
  "g"
);

export const EMAIL_REGEX =
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

export const URL_REGEX = new RegExp(
  [
    "https?:\\/\\/\\S+",
    "\\bwww\\.\\S+",
    "\\b(?:wa\\.me|t\\.me|telegram\\.me|m\\.me|fb\\.me|chat\\.whatsapp\\.com|api\\.whatsapp\\.com)(?:\\/\\S*)?",
    "\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:com|net|org|io|co|il|me|ly|app|link)\\b(?:\\/\\S*)?",
  ].join("|"),
  "gi"
);

const SOCIAL_PLATFORMS = [
  "instagram",
  "insta",
  "ig",
  "tiktok",
  "facebook",
  "fb",
  "telegram",
  "tg",
  "snapchat",
  "snap",
  "whatsapp",
  "discord",
  "twitter",
  "אינסטגרם",
  "אינסטה",
  "טיקטוק",
  "פייסבוק",
  "טלגרם",
  "סנאפצ'ט",
  "סנאפ",
  "וואטסאפ",
  "ווטסאפ",
  "ווצאפ",
].join("|");

/** `instagram: @tutor`, `ig:tutor`, `טיקטוק: tutor.il` */
export const SOCIAL_PLATFORM_HANDLE_REGEX = new RegExp(
  `(^|[^\\p{L}\\p{N}_])(?:${SOCIAL_PLATFORMS})\\s*[:：]\\s*@?[A-Za-z0-9_.]+`,
  "giu"
);

/** Bare `@username` (emails are censored before this runs). */
export const AT_HANDLE_REGEX = /(^|[^\w.@])@[A-Za-z0-9_][A-Za-z0-9_.]{1,29}/g;

const PLACEHOLDERS: Record<ChatViolation, string> = {
  phone: "[צונזר מספר טלפון]",
  email: "[צונזר אימייל]",
  external_link: "[צונזר קישור]",
  social_handle: "[צונזר פרטי קשר]",
};

/**
 * Order matters: emails before `@handle`, platform handles before URLs
 * (`tiktok: tutor.il`), links before phones (`wa.me/972…`).
 */
const RULES: ReadonlyArray<{ violation: ChatViolation; regex: RegExp; hasLead: boolean }> = [
  { violation: "email", regex: EMAIL_REGEX, hasLead: false },
  { violation: "social_handle", regex: SOCIAL_PLATFORM_HANDLE_REGEX, hasLead: true },
  { violation: "external_link", regex: URL_REGEX, hasLead: false },
  { violation: "social_handle", regex: AT_HANDLE_REGEX, hasLead: true },
  { violation: "phone", regex: PHONE_REGEX, hasLead: true },
];

export function moderateChatText(text: string): ChatModerationResult {
  const violations = new Set<ChatViolation>();
  let censoredText = text;

  for (const { violation, regex, hasLead } of RULES) {
    censoredText = censoredText.replace(regex, (_match: string, lead: unknown) => {
      violations.add(violation);
      return (hasLead && typeof lead === "string" ? lead : "") + PLACEHOLDERS[violation];
    });
  }

  return {
    isClean: violations.size === 0,
    censoredText,
    detectedViolations: [...violations],
  };
}

export function censorChatText(text: string): string {
  return moderateChatText(text).censoredText;
}

/**
 * Stream server-side regex blocklists (RE2 syntax, no lookarounds, kept short).
 * `(:?[^\d:]|:?$)` mirrors the client END guard so clock times are not blocked.
 */
export const STREAM_PHONE_BLOCK_PATTERNS = [
  "972[\\s.()-]*0?[\\s.()-]*[2-9]([\\s.()-]*\\d){7,}",
  "0[\\s.()-]*[57]([\\s.()-]*\\d){8,}(:?[^\\d:]|:?$)",
  "0[\\s.()-]*[2-489]([\\s.()-]*\\d){7,}(:?[^\\d:]|:?$)",
  "\\d{9,}",
];

export const STREAM_EMAIL_BLOCK_PATTERNS = [
  "[\\w.+-]+@[\\w.-]+\\.[A-Za-z]{2,}",
];

export const STREAM_LINK_BLOCK_PATTERNS = [
  "(?i)https?://",
  "(?i)\\bwww\\.",
  "(?i)\\b(wa|t|m|fb)\\.me\\b",
  "(?i)chat\\.whatsapp\\.com",
  "(?i)\\b(instagram|ig|tiktok|facebook|fb|telegram|snapchat)\\s*:",
];
