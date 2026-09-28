"use client";

import { useState, useMemo, useEffect, useRef, type SVGProps } from "react";
import Link from "next/link";
import { toast } from "react-hot-toast";
import {
  DiagnosticMathText,
  FormulaDisplay,
} from "../../../components/diagnostic/DiagnosticMathText";
import {
  getOnboardingChallengeQuestions,
  ENGLISH_WRITING_PROMPTS,
  type DiagnosticQuestion,
  type EnglishWritingPrompt,
} from "../../../lib/diagnostic-questions";
import {
  TRACK_OPTIONS,
  BAGRUT_SUBJECTS,
  ACADEMIC_DEGREE_FIELDS,
  MECHINA_SUBJECTS,
  MECHINA_TRACK_TYPES,
  PSYCHOMETRIC_TEST_SESSIONS,
  HS_UNIT_OPTIONS,
  SCREENING_SECTORS,
  getAcademicCourseDisplayLabel,
  getAcademicCoursesGroupedForDegree,
  type DiagnosticTrackType,
} from "../../../lib/diagnostic-taxonomy";
import {
  frostCard,
  pageCanvas,
  primaryCta,
  secondaryCta,
  fieldClass,
  eyebrow as eyebrowClass,
} from "../../../lib/ui";

/** RTL back — points right (toward previous in Hebrew reading order) */
function ArrowRight(props: SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={props.className} width={16} height={16}>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}

/** RTL proceed — points left (toward next in Hebrew reading order) */
function ArrowLeft(props: SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={props.className} width={16} height={16}>
      <path d="M19 12H5" />
      <path d="m12 19-7-7 7-7" />
    </svg>
  );
}

function LockIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path fillRule="evenodd" d="M12 1.5a5.25 5.25 0 00-5.25 5.25v3a3 3 0 00-3 3v6.75a3 3 0 003 3h10.5a3 3 0 003-3v-6.75a3 3 0 00-3-3v-3c0-2.9-2.35-5.25-5.25-5.25zm3.75 8.25v-3a3.75 3.75 0 10-7.5 0v3h7.5z" clipRule="evenodd" />
    </svg>
  );
}

type MaskedTopic = {
  id: string;
  maskedName: string;
  weightInExam: number;
  subTopicsCount?: number;
  isLocked: boolean;
};

type UnlockedTopic = {
  id: string;
  topicName: string;
  subTopics: string[] | unknown;
  weightInExam: number;
  gradeLevel: string;
};

type MatchedTeacherBrief = {
  teacherId: string;
  teacherName: string;
  matchScore: number;
  reasons: string[];
  openSlotsCount: number;
};

type PackageRecommendation = {
  packageRecommendation: "TRIO" | "MULTI";
  lessons: number;
  whatsappMessage?: string;
};

type ReadinessBadge = {
  label: string;
  tone: "green" | "amber" | "red";
};

type QuestionReviewItem = {
  questionId: string;
  topicLabel: string;
  title: string;
  context: string;
  instruction: string;
  formulaLatex?: string;
  selectedOptionId: string;
  selectedText: string;
  isCorrect: boolean;
  correctOptionId: string;
  correctText: string;
  explanation: string;
};

type SampleExplanation = QuestionReviewItem;

type TeaserResult = {
  id: string;
  isUnlocked: boolean;
  estimatedScore: number;
  recommendationSummary: string;
  topicsCount: number;
  maskedTopics?: MaskedTopic[];
  topics?: UnlockedTopic[];
  quadGroupUrl?: string;
  matchedTeacher?: MatchedTeacherBrief | null;
  paywallNotice?: string;
  recommendation?: PackageRecommendation;
  readinessBadge?: ReadinessBadge;
  sampleExplanation?: SampleExplanation | null;
  questionReviews?: QuestionReviewItem[];
};

/** Extract Hebrew pedagogical topic from question title (text after hyphen). */
function extractPedagogicalTopic(title: string): string {
  const trimmed = title.trim();
  const parts = trimmed.split(/\s*[-–—]\s*/);
  if (parts.length >= 2) {
    const after = parts.slice(1).join(" - ").trim();
    if (after.length > 0) return after;
  }
  return trimmed;
}

function optionDisplayText(opt: { mathText?: string; plainText?: string } | undefined): string {
  if (!opt) return "";
  return (opt.mathText || opt.plainText || "").trim();
}

function readinessBadgeClass(tone: ReadinessBadge["tone"]): string {
  if (tone === "green") {
    return "bg-emerald-50 border-emerald-200 text-emerald-800";
  }
  if (tone === "amber") {
    return "bg-amber-50 border-amber-200 text-amber-900";
  }
  return "bg-rose-50 border-rose-200 text-rose-800";
}

const PENDING_DIAGNOSTIC_QUIZ_KEY = "pending_diagnostic_quiz_id";
const PENDING_DIAGNOSTIC_REVIEWS_KEY = "pending_diagnostic_question_reviews";
const PENDING_DIAGNOSTIC_PACKAGE_KEY = "pending_diagnostic_package";

function persistPendingDiagnostic(opts: {
  quizId: string;
  packageRecommendation?: string;
  questionReviews?: QuestionReviewItem[];
}) {
  try {
    localStorage.setItem(PENDING_DIAGNOSTIC_QUIZ_KEY, opts.quizId);
    if (opts.packageRecommendation) {
      localStorage.setItem(PENDING_DIAGNOSTIC_PACKAGE_KEY, opts.packageRecommendation);
    }
    if (opts.questionReviews && opts.questionReviews.length > 0) {
      localStorage.setItem(
        PENDING_DIAGNOSTIC_REVIEWS_KEY,
        JSON.stringify(opts.questionReviews)
      );
    }
  } catch {
    // ignore quota / private-mode failures
  }
}

function readStoredQuestionReviews(): QuestionReviewItem[] {
  try {
    const raw = localStorage.getItem(PENDING_DIAGNOSTIC_REVIEWS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as QuestionReviewItem[]) : [];
  } catch {
    return [];
  }
}

function clearPendingDiagnosticKeys() {
  try {
    localStorage.removeItem(PENDING_DIAGNOSTIC_QUIZ_KEY);
    localStorage.removeItem(PENDING_DIAGNOSTIC_REVIEWS_KEY);
    localStorage.removeItem(PENDING_DIAGNOSTIC_PACKAGE_KEY);
  } catch {
    // ignore
  }
}

function buildPricingHref(packageId: string, quizId: string | undefined): string {
  if (!quizId) return `/pricing?package=${packageId}`;
  const returnUrl = encodeURIComponent(
    `/onboarding/diagnostic?quizId=${quizId}&unlocked=true`
  );
  return `/pricing?package=${packageId}&quizId=${quizId}&returnUrl=${returnUrl}`;
}

const EXAM_TIMEFRAMES = [
  { id: "less_than_1_month", label: "כן, פחות מחודש (דחוף ביותר)", hasExam: true },
  { id: "1_to_3_months", label: "כן, בעוד 1-3 חודשים", hasExam: true },
  { id: "no_exam_soon", label: "אין מבחן קרוב כרגע", hasExam: false },
];

const LEARNING_GOALS = [
  { id: "EXAM_PREP", title: "הכנה למבחן / בגרות / מיונים", desc: "מיקוד בנושאי מפתח ופתרון שאלות מבחן בזמן אמת" },
  { id: "GAP_CLOSING", title: "סגירת פערים יסודית", desc: "הבנת עומק של החומר מתחילת השנה וחיזוק מיומנויות בסיס" },
  { id: "HIGH_SCORE_BOOST", title: "הגעה למצטיינים (700+ / 95+ / דפ״ר 90)", desc: "ליטוש טקטי ותרגול שאלות קצה ברמת קושי מקסימלית" },
];

const fieldClassSm =
  "w-full bg-neutral-50/90 border border-neutral-200 rounded-xl px-3.5 py-2.5 text-xs font-medium text-neutral-900 text-start focus:outline-none focus:ring-2 focus:ring-neutral-900/10 focus:border-neutral-400";
const labelClass = "block text-xs font-medium text-neutral-600 mb-1.5 text-start";
const trackBadge =
  "bg-neutral-900/[0.04] border border-neutral-900/[0.08] text-neutral-800 text-xs px-3 py-1 rounded-full font-medium";
const backBtnClass = `${secondaryCta} inline-flex items-center gap-1.5 text-sm`;
const proceedBtnClass = `${primaryCta} flex-1 inline-flex items-center justify-center gap-2`;

const PSYCHOMETRIC_FRAMEWORK_OPTIONS = [
  "יואל גבע",
  "קידום",
  "היי-קיו",
  "קמפוס IL",
  "למידה עצמאית",
  "אחר",
] as const;

type PsychometricScores = {
  quantitative?: number;
  verbal?: number;
  english?: number;
  isFirstTime?: boolean;
};

const DOMAIN_BADGE_LABELS: Record<string, string> = {
  VERBAL: "חשיבה מילולית",
  QUANTITATIVE: "חשיבה כמותית",
  ENGLISH: "אנגלית",
  GEOMETRY_VECTORS: "גאומטריה ווקטורים",
  COMPLEX_NUMBERS: "מספרים מרוכבים",
  CALCULUS: "חדו״א",
  SEQUENCES: "סדרות",
  WORD_PROBLEMS: "בעיות מילוליות",
  PROBABILITY: "הסתברות",
  STATISTICS: "סטטיסטיקה",
  CALCULUS_RATIONAL: "חדו״א — פונקציות רציונליות",
  CALCULUS_RADICAL: "חדו״א — פונקציות שורש",
  OPTIMIZATION: "בעיות קיצון",
  GROWTH_DECAY: "גידול ודעיכה",
  TRIG_CALCULUS: "חדו״א טריגונומטרית",
  EXP_CALCULUS: "חדו״א מעריכית",
  LOG_CALCULUS: "חדו״א לוגריתמית",
  ELECTRICITY: "חשמל ומגנטיות",
  MECHANICS: "מכניקה",
  RADIATION: "קרינה וחומר",
  WAVES_MATTER: "קרינה וחומר",
  COMPUTER_SCIENCE: "מדעי המחשב",
  VOCABULARY: "אוצר מילים",
  RESTATEMENT: "ניסוח מחדש",
  CIVICS: "אזרחות",
  BIBLE: "תנ״ך",
  TANAKH: "תנ״ך",
  LITERATURE: "ספרות",
};

/** Clean badge label — Hebrew domain names, no internal exam codes. */
function getBadgeDisplayLabel(question: DiagnosticQuestion): string {
  const raw = question.domain?.trim() || question.title?.trim() || "";
  if (DOMAIN_BADGE_LABELS[raw]) return DOMAIN_BADGE_LABELS[raw];

  // Already-Hebrew domains (e.g. physics / academic) — strip exam/questionnaire codes
  const cleaned = raw
    .replace(/\b(שאלון\s*)?\d{3,6}\b/g, "")
    .replace(/\(\d{5,6}\)/g, "")
    .replace(/\b(581|582|481|482|801|802|803|1261|8281)\b/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s*[—–-]\s*$/g, "")
    .trim();

  if (/חשמל|מגנטיות/i.test(cleaned)) return "חשמל ומגנטיות";
  if (/מכניקה|קינטיקה|אנרגיה/i.test(cleaned)) return "מכניקה";
  if (/קרינה|חומר|אופטיקה/i.test(cleaned)) return "קרינה וחומר";
  if (/תנ״ך|תנ"ך|תנך|bible|tanakh/i.test(cleaned)) return "תנ״ך";
  if (/ספרות|literature/i.test(cleaned)) return "ספרות";

  return cleaned || "אבחון";
}

/**
 * Mechina challenge badge — track path only (never bagrut paper codes 581/582/…).
 * Examples: "מכינה - מתמטיקה", "מכינה - פיזיקה מכניקה".
 */
function getMechinaBadgeLabel(mechinaSubject: string): string {
  const s = mechinaSubject.trim();
  if (/חשמל|מגנטיות|electricity/i.test(s)) {
    return "מכינה - פיזיקה חשמל ומגנטיות";
  }
  if (/מכניקה|mechanics/i.test(s)) {
    return "מכינה - פיזיקה מכניקה";
  }
  if (/פיזיקה|mechina_physics|physics/i.test(s)) {
    return "מכינה - פיזיקה";
  }
  if (/מתמטיקה|mechina_math|math/i.test(s)) {
    return "מכינה - מתמטיקה";
  }
  const short = (s.split("(")[0] || s).trim() || "מכינה";
  return `מכינה - ${short}`;
}

/** User-facing exam-paper label; internal `code` stays unchanged for routing. */
function getExamPaperDisplayLabel(
  subjectId: string,
  paper: { code: string; name: string }
): string {
  const code = paper.code.toUpperCase();

  if (subjectId === "physics") {
    if (code.includes("036581") || code.includes("5381") || /מכניקה/.test(paper.name)) {
      return "מכניקה";
    }
    if (code.includes("036582") || code.includes("5382") || /חשמל/.test(paper.name)) {
      return "חשמל ומגנטיות";
    }
    if (code.includes("036583") || code.includes("5383") || /קרינה|חומר|אופטיקה/.test(paper.name)) {
      return "קרינה וחומר";
    }
    if (code.includes("036586") || /מעבד/.test(paper.name)) return "מעבדת חקר";
    if (code.startsWith("ALL")) return "מיקוד מלא";
    return paper.name.replace(/\(שאלון[^)]*\)/g, "").replace(/\s{2,}/g, " ").trim();
  }

  if (subjectId === "cs") {
    if (code.includes("899381") || code === "CS_1" || /ראשון|יסודות/.test(paper.name)) {
      return "שאלון ראשון";
    }
    if (
      code.includes("899282") ||
      code.includes("899283") ||
      code === "CS_2" ||
      /שני|מבני נתונים|אוטומט/.test(paper.name)
    ) {
      return "שאלון שני";
    }
    if (code.startsWith("ALL")) return "מיקוד מלא";
    return paper.name.replace(/\(שאלון[^)]*\)/g, "").replace(/\s{2,}/g, " ").trim();
  }

  if (subjectId === "hebrew_lang" || subjectId === "hebrew") {
    if (
      code === "HEBREW_1" ||
      code === "HEB_1" ||
      code.includes("011281") ||
      code.includes("11281") ||
      /ראשון|צורות|תחביר|פיסוק|מספר/.test(paper.name)
    ) {
      return "שאלון ראשון";
    }
    if (
      code === "HEBREW_2" ||
      code === "HEB_2" ||
      code.includes("011282") ||
      code.includes("11282") ||
      /שני|הבנה|ניבים|סמנטיקה|הבעה/.test(paper.name)
    ) {
      return "שאלון שני";
    }
    return paper.name
      .replace(/\(\s*\d{3,6}[^)]*\)/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  if (subjectId === "civics") {
    if (
      code === "CIVICS_1" ||
      code.includes("34281") ||
      code.includes("034281") ||
      /ראשון/.test(paper.name)
    ) {
      return "שאלון ראשון";
    }
    if (
      code === "CIVICS_2" ||
      code.includes("34282") ||
      code.includes("034282") ||
      /שני/.test(paper.name)
    ) {
      return "שאלון שני";
    }
    return paper.name
      .replace(/\(\s*\d{3,6}[^)]*\)/g, "")
      .replace(/\b0?3428[12]\b/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  if (subjectId === "history") {
    if (
      code === "HISTORY_1" ||
      code === "HIST_1" ||
      code.includes("22261") ||
      code.includes("022261") ||
      /ראשון/.test(paper.name)
    ) {
      return "שאלון ראשון";
    }
    if (
      code === "HISTORY_2" ||
      code === "HIST_2" ||
      code.includes("22262") ||
      code.includes("022262") ||
      /שני/.test(paper.name)
    ) {
      return "שאלון שני";
    }
    return paper.name
      .replace(/\(\s*\d{3,6}[^)]*\)/g, "")
      .replace(/\b0?2226[12]\b/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  // Bible — single unified theoretical questionnaire; never surface paper codes
  if (subjectId === "bible" || subjectId === "tanakh") {
    return "שאלון עיוני";
  }

  // Literature — single unified theoretical questionnaire; never surface 8281
  if (subjectId === "literature") {
    return "שאלון עיוני";
  }

  // Math 4/5 (and similar dual-paper subjects): first / second questionnaire only
  if (code.includes("581") || code.includes("481") || code.includes("801")) {
    return "שאלון ראשון";
  }
  if (code.includes("582") || code.includes("482") || code.includes("802")) {
    return "שאלון שני";
  }
  if (code.includes("803")) return "שאלון שלישי";
  if (code.startsWith("ALL")) return "מיקוד מלא";

  // Fallback: strip internal codes from taxonomy name
  return paper.name
    .replace(/שאלון\s*\d+\s*/g, "")
    .replace(/\(\s*\d{3,6}[^)]*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^\s*[-–—]\s*/, "")
    .trim() || paper.name;
}

function isPsychometricScoreOutOfRange(value: number): boolean {
  return value < 50 || value > 150;
}

/** RTL answer row: radio (shrink-0) at start/right, text+math beside it. */
function choiceCardClass(isSelected: boolean): string {
  return `w-full p-3.5 rounded-2xl text-start transition-all flex flex-row items-center gap-3 ${
    isSelected
      ? "border-2 border-neutral-900 bg-neutral-50"
      : "border border-neutral-200 bg-white hover:border-neutral-300 hover:shadow-sm"
  }`;
}

function checkDotClass(isSelected: boolean): string {
  return `w-5 h-5 rounded-full border flex items-center justify-center text-xs shrink-0 ${
    isSelected ? "bg-neutral-900 border-neutral-900 text-white" : "border-neutral-300"
  }`;
}

export default function OnboardingDiagnosticPage() {
  // Navigation state machine
  const [activeTrack, setActiveTrack] = useState<DiagnosticTrackType>("BAGRUT");
  // microStep:
  // 1: Track Selection
  // 2: Track-Specific Parameters
  // 3: Contact & Institution Info
  // 4: Urgency & Baseline Grade
  // 5: 3-Domain Challenge Suite
  // 6: Gated Teaser Paywall & Gauge
  // 7: Unlocked Knowledge Tree
  const [microStep, setMicroStep] = useState<1 | 2 | 3 | 4 | 5 | 6 | 7>(1);
  const [loading, setLoading] = useState(false);
  const unlockResumeAttempted = useRef(false);

  // Common Contact & Profile Fields
  const [studentName, setStudentName] = useState("");
  const [studentPhone, setStudentPhone] = useState("");
  const [parentName, setParentName] = useState("");
  const [parentPhone, setParentPhone] = useState("");
  const [schoolName, setSchoolName] = useState("");
  /** Psychometric-only: course / learning framework (reuses schoolName on submit). */
  const [psychFramework, setPsychFramework] = useState<string>("");
  const [psychFrameworkOther, setPsychFrameworkOther] = useState("");

  // Common Urgency & Goals
  const [selectedTimeframe, setSelectedTimeframe] = useState("less_than_1_month");
  const [learningGoal, setLearningGoal] = useState("EXAM_PREP");
  const [lastGrade, setLastGrade] = useState<number>(64);

  // Track 1: Bagrut Fields
  const [bagrutSubjectId, setBagrutSubjectId] = useState("math");
  const [bagrutUnitCount, setBagrutUnitCount] = useState<number>(5);
  const [bagrutExamCode, setBagrutExamCode] = useState("35582");

  // Track 2: Academic Fields
  const [degreeFieldId, setDegreeFieldId] = useState("cs_sw_eng");
  const [selectedCourse, setSelectedCourse] = useState("חדו״א / אינפי");

  // Track 3: Mechina Fields
  const [mechinaSubject, setMechinaSubject] = useState(MECHINA_SUBJECTS[0]);
  const [mechinaTrackType, setMechinaTrackType] = useState(MECHINA_TRACK_TYPES[0]);

  // Track 4: Psychometric Fields
  const [hsMathUnits, setHsMathUnits] = useState<number>(5);
  const [hsEnglishUnits, setHsEnglishUnits] = useState<number>(5);
  const [isFirstPsychometric, setIsFirstPsychometric] = useState<boolean>(true);
  const [prevPsychQuant, setPrevPsychQuant] = useState<number>(105);
  const [prevPsychVerbal, setPrevPsychVerbal] = useState<number>(108);
  const [prevPsychEnglish, setPrevPsychEnglish] = useState<number>(112);
  const [targetPsychSession, setTargetPsychSession] = useState(PSYCHOMETRIC_TEST_SESSIONS[0]);
  /** Optional structured scores blob — backward-compatible additive field. */
  const [psychometricScores, setPsychometricScores] = useState<PsychometricScores>({
    isFirstTime: true,
    quantitative: 105,
    verbal: 108,
    english: 112,
  });

  const isPsychometric = activeTrack === "PSYCHOMETRIC";

  // Track 5: Screening & Placement Fields
  const [screeningSectorId, setScreeningSectorId] = useState("defense_idf");
  const [screeningInstituteId, setScreeningInstituteId] = useState("idf_internal");
  const [screeningBattery, setScreeningBattery] = useState("מבחן דפ״ר אדפטיבי (צו ראשון)");

  // Step 5: 3-Domain Question Answers State
  const [currentQuestionIdx, setCurrentQuestionIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  /** English-only: optional writing phase after MC trio. */
  const [showEnglishWriting, setShowEnglishWriting] = useState(false);
  const [englishWritingText, setEnglishWritingText] = useState("");

  // Teaser & Quad Data
  const [teaserData, setTeaserData] = useState<TeaserResult | null>(null);

  // Derived taxonomy options
  const selectedBagrutSubject = useMemo(
    () => BAGRUT_SUBJECTS.find((s) => s.id === bagrutSubjectId) || BAGRUT_SUBJECTS[0],
    [bagrutSubjectId]
  );
  const availableBagrutUnits = selectedBagrutSubject.units;
  const selectedBagrutUnit = useMemo(
    () => availableBagrutUnits.find((u) => u.unitCount === bagrutUnitCount) || availableBagrutUnits[0],
    [availableBagrutUnits, bagrutUnitCount]
  );

  const selectedDegreeField = useMemo(
    () => ACADEMIC_DEGREE_FIELDS.find((d) => d.id === degreeFieldId) || ACADEMIC_DEGREE_FIELDS[0],
    [degreeFieldId]
  );
  const academicCourseGroups = useMemo(
    () => getAcademicCoursesGroupedForDegree(selectedDegreeField),
    [selectedDegreeField]
  );
  const academicCourseOptions = useMemo(
    () => academicCourseGroups.flatMap((g) => g.courses),
    [academicCourseGroups]
  );

  const selectedScreeningSector = useMemo(
    () => SCREENING_SECTORS.find((s) => s.id === screeningSectorId) || SCREENING_SECTORS[0],
    [screeningSectorId]
  );
  const selectedScreeningInstitute = useMemo(
    () => selectedScreeningSector.institutes.find((i) => i.id === screeningInstituteId) || selectedScreeningSector.institutes[0],
    [selectedScreeningSector, screeningInstituteId]
  );

  // Dynamic progress steps calculation
  const totalFunnelSteps = 5;
  const progressPercent = Math.min(100, Math.round((microStep / totalFunnelSteps) * 100));

  // Track-bound challenge suite (exam/course → parent category → track default)
  const challengeQuestions: DiagnosticQuestion[] = useMemo(
    () =>
      getOnboardingChallengeQuestions({
        trackType: activeTrack,
        examCode: activeTrack === "BAGRUT" ? bagrutExamCode : null,
        subjectId: activeTrack === "BAGRUT" ? bagrutSubjectId : null,
        courseId: activeTrack === "ACADEMIC" ? selectedCourse : null,
        mechinaSubject: activeTrack === "MECHINA" ? mechinaSubject : null,
        screeningBattery: activeTrack === "SCREENING_INST" ? screeningBattery : null,
      }),
    [
      activeTrack,
      bagrutExamCode,
      bagrutSubjectId,
      selectedCourse,
      mechinaSubject,
      screeningBattery,
    ]
  );

  const activeQuestion: DiagnosticQuestion | undefined =
    challengeQuestions[Math.min(currentQuestionIdx, Math.max(0, challengeQuestions.length - 1))];

  const isEnglishBagrut =
    activeTrack === "BAGRUT" && bagrutSubjectId === "english";

  const englishWritingPrompt: EnglishWritingPrompt | null = useMemo(() => {
    if (!isEnglishBagrut) return null;
    return bagrutUnitCount === 4
      ? ENGLISH_WRITING_PROMPTS["4_POINTS"]
      : ENGLISH_WRITING_PROMPTS["5_POINTS"];
  }, [isEnglishBagrut, bagrutUnitCount]);

  const englishWordCount = useMemo(() => {
    const trimmed = englishWritingText.trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).filter(Boolean).length;
  }, [englishWritingText]);

  // Reset answers/index when the track-bound question bank changes
  useEffect(() => {
    setCurrentQuestionIdx(0);
    setAnswers({});
    setShowEnglishWriting(false);
    setEnglishWritingText("");
  }, [challengeQuestions]);

  // Keep selected academic course inside the flat optgroup list for the active degree
  useEffect(() => {
    if (activeTrack !== "ACADEMIC") return;
    if (academicCourseOptions.length === 0) return;
    if (!academicCourseOptions.some((c) => c.value === selectedCourse)) {
      setSelectedCourse(academicCourseOptions[0].value);
    }
  }, [activeTrack, academicCourseOptions, selectedCourse]);

  // Post-purchase resume: unlock pending diagnostic and jump to microStep 7
  useEffect(() => {
    if (unlockResumeAttempted.current) return;
    if (typeof window === "undefined") return;

    const params = new URLSearchParams(window.location.search);
    const unlockedFlag = params.get("unlocked") === "true";
    if (!unlockedFlag) return;

    let storedQuizId: string | null = null;
    try {
      storedQuizId = localStorage.getItem(PENDING_DIAGNOSTIC_QUIZ_KEY);
    } catch {
      storedQuizId = null;
    }

    const quizId = params.get("quizId") || storedQuizId;
    if (!quizId) return;

    unlockResumeAttempted.current = true;

    const resumeUnlock = async () => {
      setLoading(true);
      const toastId = toast.loading("פותחים את הדו״ח המלא...");

      type UnlockPayload = {
        success?: boolean;
        error?: string;
        requiresPurchase?: boolean;
        data?: {
          id: string;
          isUnlocked: boolean;
          estimatedScore?: number | null;
          recommendationSummary?: string | null;
          topics?: UnlockedTopic[];
          matchedTeacher?: MatchedTeacherBrief | null;
          quadGroupUrl?: string;
        };
      };

      const callUnlock = async (): Promise<{ res: Response; data: UnlockPayload }> => {
        const res = await fetch("/api/diagnostic/unlock", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ diagnosticId: quizId }),
        });
        const data = (await res.json()) as UnlockPayload;
        return { res, data };
      };

      try {
        let { res, data } = await callUnlock();

        if (res.status === 401 || res.status === 403) {
          toast.error("יש להתחבר כדי לפתוח את הדו״ח", { id: toastId });
          const from = encodeURIComponent(
            `/onboarding/diagnostic?quizId=${quizId}&unlocked=true`
          );
          window.location.assign(`/login?from=${from}`);
          return;
        }

        // Stripe webhook may lag briefly after checkout — one short retry.
        if (res.status === 402 || data.requiresPurchase) {
          await new Promise((r) => setTimeout(r, 1500));
          ({ res, data } = await callUnlock());
        }

        if (res.status === 402 || data.requiresPurchase) {
          toast.error(data.error || "נדרשת רכישת חבילה לפתיחת הדו״ח", { id: toastId });
          const returnUrl = encodeURIComponent(
            `/onboarding/diagnostic?quizId=${quizId}&unlocked=true`
          );
          window.location.assign(
            `/pricing?quizId=${encodeURIComponent(quizId)}&returnUrl=${returnUrl}`
          );
          return;
        }

        if (!res.ok || !data.success || !data.data) {
          throw new Error(data.error || "פתיחת הדו״ח נכשלה");
        }

        const unlocked = data.data;
        const storedReviews = readStoredQuestionReviews();
        const score = unlocked.estimatedScore ?? 0;
        const badge: ReadinessBadge =
          score >= 80
            ? { label: "בסיס אקדמי איתן", tone: "green" }
            : score >= 55
              ? { label: "נדרש חידוד ותרגול ממוקד", tone: "amber" }
              : { label: "אותרו פערי ליבה קריטיים", tone: "red" };

        setTeaserData({
          id: unlocked.id,
          isUnlocked: true,
          estimatedScore: score,
          recommendationSummary: unlocked.recommendationSummary ?? "",
          topicsCount: unlocked.topics?.length ?? 0,
          topics: unlocked.topics,
          matchedTeacher: unlocked.matchedTeacher ?? null,
          quadGroupUrl: unlocked.quadGroupUrl,
          questionReviews: storedReviews,
          sampleExplanation:
            storedReviews.find((r) => !r.isCorrect) ?? storedReviews[0] ?? null,
          readinessBadge: badge,
        });
        setMicroStep(7);
        clearPendingDiagnosticKeys();
        toast.success("הדו״ח המלא נפתח בהצלחה!", { id: toastId });
        window.history.replaceState({}, "", "/onboarding/diagnostic");
      } catch (err: unknown) {
        toast.error(
          err instanceof Error ? err.message : "שגיאה בפתיחת הדו״ח",
          { id: toastId }
        );
      } finally {
        setLoading(false);
      }
    };

    void resumeUnlock();
  }, []);

  const handleSelectOption = (questionId: string, optionId: string) => {
    setAnswers((prev) => ({ ...prev, [questionId]: optionId }));
  };

  const handleNextQuestion = () => {
    if (!activeQuestion || !answers[activeQuestion.id]) {
      toast.error("יש לבחור תשובה כדי להמשיך לשאלה הבאה");
      return;
    }
    if (currentQuestionIdx < challengeQuestions.length - 1) {
      setCurrentQuestionIdx((prev) => prev + 1);
    }
  };

  const handlePrevQuestion = () => {
    if (showEnglishWriting) {
      setShowEnglishWriting(false);
      return;
    }
    if (currentQuestionIdx > 0) {
      setCurrentQuestionIdx((prev) => prev - 1);
    }
  };

  // Compile final Subject / Topic representation for matching engine
  const getDerivedSubject = () => {
    switch (activeTrack) {
      case "BAGRUT":
        return `${selectedBagrutSubject.name} (${bagrutUnitCount} יח״ל - ${bagrutExamCode})`;
      case "ACADEMIC":
        return `${getAcademicCourseDisplayLabel(selectedCourse)} (${selectedDegreeField.name})`;
      case "MECHINA":
        return `${mechinaSubject} (${mechinaTrackType})`;
      case "PSYCHOMETRIC":
        return `פסיכומטרי (${targetPsychSession})`;
      case "SCREENING_INST":
        return `${screeningBattery} (${selectedScreeningInstitute.name})`;
      default:
        return "מתמטיקה (5 יח״ל)";
    }
  };

  const handleSubmitDiagnostic = async (opts?: { skipWriting?: boolean }) => {
    if (!activeQuestion || !answers[activeQuestion.id]) {
      toast.error("יש לבחור תשובה לשאלה הנוכחית");
      return;
    }

    let correctCount = 0;
    const answerSummaries: string[] = [];
    const weakDomains: string[] = [];
    const questionReviews: QuestionReviewItem[] = [];

    challengeQuestions.forEach((q) => {
      const selectedOptId = answers[q.id];
      const opt = q.options.find((o) => o.id === selectedOptId);
      const correctOpt = q.options.find((o) => o.isCorrect);
      const topicLabel = extractPedagogicalTopic(q.title);
      const isCorrect = !!opt?.isCorrect;

      if (isCorrect) {
        correctCount++;
      } else {
        weakDomains.push(topicLabel);
      }

      answerSummaries.push(
        `${topicLabel}: ${optionDisplayText(opt) || "לא נענה"}`
      );

      questionReviews.push({
        questionId: q.id,
        topicLabel,
        title: q.title,
        context: q.context,
        instruction: q.instruction,
        formulaLatex: q.formulaLatex,
        selectedOptionId: selectedOptId || "",
        selectedText: optionDisplayText(opt) || "לא נענה",
        isCorrect,
        correctOptionId: correctOpt?.id || "",
        correctText: optionDisplayText(correctOpt),
        explanation: correctOpt?.explanation || opt?.explanation || "",
      });
    });

    const writingForSubmit =
      opts?.skipWriting ? "" : englishWritingText.trim();
    if (isEnglishBagrut && writingForSubmit) {
      const words = writingForSubmit.split(/\s+/).filter(Boolean).length;
      answerSummaries.push(
        `WRITING (${words} words): ${writingForSubmit.slice(0, 500)}`
      );
    }

    const timeframeObj = EXAM_TIMEFRAMES.find((t) => t.id === selectedTimeframe);
    const resolvedSubject = getDerivedSubject();
    const resolvedAgeGroup = activeTrack === "ACADEMIC" || activeTrack === "MECHINA" || activeTrack === "PSYCHOMETRIC"
      ? "ACADEMIC"
      : activeTrack === "SCREENING_INST"
        ? "ACADEMIC"
        : "HIGH_SCHOOL";

    const resolvedPsychFramework =
      psychFramework === "אחר"
        ? psychFrameworkOther.trim() || "אחר"
        : psychFramework.trim();
    const resolvedSchoolName = isPsychometric
      ? resolvedPsychFramework || null
      : schoolName.trim() || null;

    const resolvedPsychScores: PsychometricScores | null = isPsychometric
      ? {
          isFirstTime: isFirstPsychometric,
          quantitative: isFirstPsychometric
            ? undefined
            : psychometricScores.quantitative ?? prevPsychQuant,
          verbal: isFirstPsychometric
            ? undefined
            : psychometricScores.verbal ?? prevPsychVerbal,
          english: isFirstPsychometric
            ? undefined
            : psychometricScores.english ?? prevPsychEnglish,
        }
      : null;

    setLoading(true);
    try {
      const res = await fetch("/api/diagnostic/teaser", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentName: studentName.trim() || "תלמיד",
          studentPhone: studentPhone.trim() || "0500000000",
          parentName: isPsychometric ? null : parentName.trim() || null,
          parentPhone: isPsychometric ? null : parentPhone.trim() || null,
          schoolName: resolvedSchoolName,
          classTrack: activeTrack === "BAGRUT" ? `${bagrutUnitCount} יח״ל` : activeTrack,
          trackType: activeTrack,
          ageGroup: resolvedAgeGroup,
          subject: resolvedSubject,
          examNumber: activeTrack === "BAGRUT" ? bagrutExamCode : null,
          unitsCount: activeTrack === "BAGRUT" ? bagrutUnitCount : activeTrack === "PSYCHOMETRIC" ? hsMathUnits : null,
          degreeField: activeTrack === "ACADEMIC" ? selectedDegreeField.name : null,
          academicYear: null,
          coreCourse:
            activeTrack === "ACADEMIC"
              ? getAcademicCourseDisplayLabel(selectedCourse)
              : null,
          mechinaTrack: activeTrack === "MECHINA" ? mechinaTrackType : null,
          isFirstAttempt: activeTrack === "PSYCHOMETRIC" ? isFirstPsychometric : null,
          psychometricTotal: null,
          psychometricQuant: activeTrack === "PSYCHOMETRIC" && !isFirstPsychometric ? prevPsychQuant : null,
          psychometricVerbal: activeTrack === "PSYCHOMETRIC" && !isFirstPsychometric ? prevPsychVerbal : null,
          psychometricEnglish: activeTrack === "PSYCHOMETRIC" && !isFirstPsychometric ? prevPsychEnglish : null,
          psychometricScores: resolvedPsychScores,
          targetTestSession: activeTrack === "PSYCHOMETRIC" ? targetPsychSession : null,
          targetOrganization: activeTrack === "SCREENING_INST" ? selectedScreeningSector.name : null,
          testingInstitute: activeTrack === "SCREENING_INST" ? selectedScreeningInstitute.name : null,
          examBattery: activeTrack === "SCREENING_INST" ? screeningBattery : null,
          hasUpcomingExam: timeframeObj?.hasExam ?? true,
          examTimeframe: selectedTimeframe,
          learningGoal,
          lastGrade: isPsychometric ? null : lastGrade,
          challenge: `${learningGoal} - ${resolvedSubject}`,
          challengeAnswer: answerSummaries.join(" | "),
          correctCount,
          totalQuestions: challengeQuestions.length,
          isChallengeCorrect: correctCount === challengeQuestions.length,
          weakDomains,
          questionReviews,
          topicIds: [],
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "שגיאה בעיבוד האבחון");
      }

      setTeaserData(data.data);
      if (data.data?.id) {
        persistPendingDiagnostic({
          quizId: data.data.id,
          packageRecommendation:
            data.data.recommendation?.packageRecommendation ??
            (data.data.topicsCount >= 3 ? "MULTI" : "TRIO"),
          questionReviews,
        });
      }
      if (data.data.isUnlocked) {
        setMicroStep(7);
      } else {
        setMicroStep(6);
      }
      toast.success("אבחון פערי הידע הושלם בהצלחה!");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "שגיאה בחישוב האבחון");
    } finally {
      setLoading(false);
    }
  };

  const recommendedPackage =
    teaserData?.recommendation?.packageRecommendation ??
    (teaserData && teaserData.topicsCount >= 3 ? "MULTI" : "TRIO");
  const recommendedLessons =
    teaserData?.recommendation?.lessons ?? (recommendedPackage === "MULTI" ? 5 : 3);
  const pricingHref = buildPricingHref(recommendedPackage, teaserData?.id);

  const stepLabel =
    microStep === 1 ? "בחירת מסלול לימודים" :
    microStep === 2 ? "אפיון מקצוע ודרישות" :
    microStep === 3 ? "פרטי התקשרות ומוסד" :
    microStep === 4 ? "דחיפות וציון בסיס" : `שאלות עומק (${currentQuestionIdx + 1}/3)`;

  return (
    <div className={`${pageCanvas}`} dir="rtl">
      <div className="max-w-3xl mx-auto px-4 py-8 sm:py-12 space-y-8">
        {microStep <= 5 && (
          <div className="space-y-2 max-w-md mx-auto">
            <div className="flex items-center justify-between text-xs font-medium text-neutral-500">
              <span className="text-neutral-900">
                שלב {microStep} מתוך {totalFunnelSteps}: {stepLabel}
              </span>
              <span>{progressPercent}%</span>
            </div>
            <div className="h-1.5 w-full bg-neutral-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-neutral-900 transition-all duration-300 rounded-full"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
        )}

        {/* MICRO-STEP 1: TRACK SELECTION */}
        {microStep === 1 && (
          <section className={`${frostCard} p-6 sm:p-8 space-y-6`}>
            <div className="text-start">
              <span className={eyebrowClass}>שלב 1: מסלול לימודים מרכזי</span>
              <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-neutral-900 mt-1 [text-wrap:balance]">
                באיזה תחום לימוד תרצו להתמקד?
              </h1>
              <p className="text-sm text-neutral-500 font-medium mt-2">
                התאמת תוכנית הלמידה והמיקוד לפי תחום הלימוד שנבחר
              </p>
            </div>

            <div className="grid gap-3.5 sm:grid-cols-1">
              {TRACK_OPTIONS.map((track) => {
                const isSelected = activeTrack === track.id;
                return (
                  <button
                    key={track.id}
                    type="button"
                    onClick={() => setActiveTrack(track.id)}
                    className={`p-4 sm:p-5 rounded-2xl text-start transition-all flex items-center justify-between group ${
                      isSelected
                        ? "border-2 border-neutral-900 bg-neutral-50"
                        : "border border-neutral-200 bg-white hover:border-neutral-300 hover:shadow-sm"
                    }`}
                  >
                    <span className={checkDotClass(isSelected)}>
                      {isSelected && "✓"}
                    </span>
                    <div className="flex flex-1 items-center gap-4 ps-3">
                      <span className="text-sm font-semibold tracking-tight text-neutral-700 p-3 bg-neutral-50 rounded-2xl border border-neutral-200 min-w-[3rem] text-center">
                        {track.icon}
                      </span>
                      <div className="text-start">
                        <div className="flex items-center gap-2">
                          <span className="text-base font-semibold text-neutral-900">{track.title}</span>
                          <span className={trackBadge}>{track.tag}</span>
                        </div>
                        <p className="text-xs text-neutral-500 font-medium mt-1">{track.subtitle}</p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              onClick={() => setMicroStep(2)}
              className={`${primaryCta} w-full inline-flex items-center justify-center gap-2`}
            >
              <ArrowLeft className="me-2" />
              המשך לאפיון המסלול
            </button>
          </section>
        )}

        {/* MICRO-STEP 2: TRACK-SPECIFIC TAXONOMY */}
        {microStep === 2 && (
          <section className={`${frostCard} p-6 sm:p-8 space-y-6`}>
            <div className="text-start">
              <span className={eyebrowClass}>
                שלב 2: אפיון מקצוע ושאלון ({TRACK_OPTIONS.find((t) => t.id === activeTrack)?.title})
              </span>
              <h2 className="text-2xl font-semibold tracking-tight text-neutral-900 mt-1 [text-wrap:balance]">
                הגדירו את המקצוע ורמת הקושי המדויקת
              </h2>
            </div>

            {activeTrack === "BAGRUT" && (
              <div className="space-y-4">
                <div>
                  <label className={labelClass}>מקצוע בגרות</label>
                  <select
                    value={bagrutSubjectId}
                    onChange={(e) => {
                      setBagrutSubjectId(e.target.value);
                      const subj = BAGRUT_SUBJECTS.find((s) => s.id === e.target.value);
                      if (subj && subj.units[0]) {
                        setBagrutUnitCount(subj.units[0].unitCount);
                        setBagrutExamCode(subj.units[0].examPapers[0]?.code || "");
                      }
                    }}
                    className={fieldClass}
                  >
                    {BAGRUT_SUBJECTS.map((sub) => (
                      <option key={sub.id} value={sub.id}>{sub.name}</option>
                    ))}
                  </select>
                </div>

                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label className={labelClass}>מספר יחידות לימוד</label>
                    <select
                      value={bagrutUnitCount}
                      onChange={(e) => {
                        const count = Number(e.target.value);
                        setBagrutUnitCount(count);
                        const unitObj = availableBagrutUnits.find((u) => u.unitCount === count);
                        if (unitObj && unitObj.examPapers[0]) {
                          setBagrutExamCode(unitObj.examPapers[0].code);
                        }
                      }}
                      className={fieldClass}
                    >
                      {availableBagrutUnits.map((u) => (
                        <option key={u.unitCount} value={u.unitCount}>{u.label}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className={labelClass}>
                      {bagrutSubjectId === "physics" ? "תחום פיזיקה" : "שאלון יעד"}
                    </label>
                    <select
                      value={bagrutExamCode}
                      onChange={(e) => setBagrutExamCode(e.target.value)}
                      className={fieldClass}
                    >
                      {selectedBagrutUnit.examPapers
                        .filter((paper) => {
                          const c = paper.code.toUpperCase();
                          if (bagrutSubjectId === "physics") {
                            return (
                              c.includes("036581") ||
                              c.includes("036582") ||
                              c.includes("036583") ||
                              /מכניקה|חשמל|קרינה|חומר/.test(paper.name)
                            );
                          }
                          // CS 5U: first + second questionnaire only
                          if (bagrutSubjectId === "cs") {
                            return !c.startsWith("ALL");
                          }
                          // Math 4/5 (dual-paper): only first + second questionnaire labels
                          if (
                            bagrutSubjectId === "math" &&
                            (bagrutUnitCount === 4 || bagrutUnitCount === 5)
                          ) {
                            return !c.startsWith("ALL");
                          }
                          return true;
                        })
                        .map((paper) => (
                          <option key={paper.code} value={paper.code}>
                            {getExamPaperDisplayLabel(bagrutSubjectId, paper)}
                          </option>
                        ))}
                    </select>
                  </div>
                </div>
              </div>
            )}

            {activeTrack === "ACADEMIC" && (
              <div className="space-y-4">
                <div>
                  <label className={labelClass}>תחום התואר האקדמי</label>
                  <select
                    value={degreeFieldId}
                    onChange={(e) => {
                      const nextId = e.target.value;
                      setDegreeFieldId(nextId);
                      const field =
                        ACADEMIC_DEGREE_FIELDS.find((d) => d.id === nextId) ||
                        ACADEMIC_DEGREE_FIELDS[0];
                      const groups = getAcademicCoursesGroupedForDegree(field);
                      const first = groups.flatMap((g) => g.courses)[0];
                      setSelectedCourse(first?.value ?? "חדו״א / אינפי");
                    }}
                    className={fieldClass}
                  >
                    {ACADEMIC_DEGREE_FIELDS.map((deg) => (
                      <option key={deg.id} value={deg.id}>{deg.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className={labelClass}>קורס הליבה המבוקש</label>
                  <select
                    value={
                      academicCourseOptions.some((c) => c.value === selectedCourse)
                        ? selectedCourse
                        : academicCourseOptions[0]?.value ?? ""
                    }
                    onChange={(e) => setSelectedCourse(e.target.value)}
                    className={fieldClass}
                  >
                    {academicCourseGroups.map((group) => (
                      <optgroup key={group.id} label={group.label}>
                        {group.courses.map((course) => (
                          <option key={course.value} value={course.value}>
                            {course.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {activeTrack === "MECHINA" && (
              <div className="space-y-4">
                <div>
                  <label className={labelClass}>מקצוע מכינה מבוקש</label>
                  <select
                    value={mechinaSubject}
                    onChange={(e) => setMechinaSubject(e.target.value)}
                    className={fieldClass}
                  >
                    {MECHINA_SUBJECTS.map((sub) => (
                      <option key={sub} value={sub}>{sub}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className={labelClass}>מסלול המכינה</label>
                  <select
                    value={mechinaTrackType}
                    onChange={(e) => setMechinaTrackType(e.target.value)}
                    className={fieldClass}
                  >
                    {MECHINA_TRACK_TYPES.map((tr) => (
                      <option key={tr} value={tr}>{tr}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {activeTrack === "PSYCHOMETRIC" && (
              <div className="space-y-5">
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label className={labelClass}>יחידות מתמטיקה בתיכון</label>
                    <select
                      value={hsMathUnits}
                      onChange={(e) => setHsMathUnits(Number(e.target.value))}
                      className={fieldClass}
                    >
                      {HS_UNIT_OPTIONS.map((opt) => (
                        <option key={opt.val} value={opt.val}>{opt.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={labelClass}>יחידות אנגלית בתיכון</label>
                    <select
                      value={hsEnglishUnits}
                      onChange={(e) => setHsEnglishUnits(Number(e.target.value))}
                      className={fieldClass}
                    >
                      {HS_UNIT_OPTIONS.map((opt) => (
                        <option key={opt.val} value={opt.val}>{opt.label}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className={labelClass}>מועד בחינה יעד</label>
                  <select
                    value={targetPsychSession}
                    onChange={(e) => setTargetPsychSession(e.target.value)}
                    className={fieldClass}
                  >
                    {PSYCHOMETRIC_TEST_SESSIONS.map((sess) => (
                      <option key={sess} value={sess}>{sess}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {activeTrack === "SCREENING_INST" && (
              <div className="space-y-4">
                <div>
                  <label className={labelClass}>5.1 גוף יעד / סקטור מיונים</label>
                  <select
                    value={screeningSectorId}
                    onChange={(e) => {
                      setScreeningSectorId(e.target.value);
                      const sec = SCREENING_SECTORS.find((s) => s.id === e.target.value);
                      if (sec && sec.institutes[0]) {
                        setScreeningInstituteId(sec.institutes[0].id);
                        setScreeningBattery(sec.institutes[0].batteries[0] || "");
                      }
                    }}
                    className={fieldClass}
                  >
                    {SCREENING_SECTORS.map((sec) => (
                      <option key={sec.id} value={sec.id}>{sec.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className={labelClass}>5.2 מכון מיון / מסגרת בחינה</label>
                  <select
                    value={screeningInstituteId}
                    onChange={(e) => {
                      setScreeningInstituteId(e.target.value);
                      const inst = selectedScreeningSector.institutes.find((i) => i.id === e.target.value);
                      if (inst && inst.batteries[0]) {
                        setScreeningBattery(inst.batteries[0]);
                      }
                    }}
                    className={fieldClass}
                  >
                    {selectedScreeningSector.institutes.map((inst) => (
                      <option key={inst.id} value={inst.id}>{inst.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className={labelClass}>5.3 סוללת מבחנים מבוקשת</label>
                  <select
                    value={screeningBattery}
                    onChange={(e) => setScreeningBattery(e.target.value)}
                    className={fieldClass}
                  >
                    {selectedScreeningInstitute.batteries.map((bat) => (
                      <option key={bat} value={bat}>{bat}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={() => setMicroStep(1)}
                className={backBtnClass}
              >
                חזרה למסלולים
                <ArrowRight className="ms-2" />
              </button>
              <button
                type="button"
                onClick={() => setMicroStep(3)}
                className={proceedBtnClass}
              >
                <ArrowLeft className="me-2" />
                המשך לפרטי התקשרות
              </button>
            </div>
          </section>
        )}

        {/* MICRO-STEP 3: CONTACT & INSTITUTION */}
        {microStep === 3 && (
          <section className={`${frostCard} p-6 sm:p-8 space-y-6`}>
            <div className="text-start">
              <span className={eyebrowClass}>
                {isPsychometric ? "שלב 3: רקע ומסגרת למידה" : "שלב 3: מוסד לימודים וחיבור הורים"}
              </span>
              <h2 className="text-2xl font-semibold tracking-tight text-neutral-900 mt-1 [text-wrap:balance]">
                {isPsychometric ? "פרטי רקע להתאמת מסלול" : "פרטי התקשרות לליווי משותף"}
              </h2>
              {!isPsychometric && (
                <p className="text-xs text-neutral-500 font-medium mt-1">
                  קבוצת הווטסאפ המרובעת מחברת מנהל פדגוגי, מורה מומחה, הורה ותלמיד לעדכונים שוטפים.
                </p>
              )}
            </div>

            <div className="space-y-4">
              {isPsychometric ? (
                <div className="space-y-3">
                  <label className={labelClass}>איזה קורס עשית / מסגרת למידה?</label>
                  <div className="flex flex-wrap gap-2">
                    {PSYCHOMETRIC_FRAMEWORK_OPTIONS.map((opt) => {
                      const selected = psychFramework === opt;
                      return (
                        <button
                          key={opt}
                          type="button"
                          onClick={() => setPsychFramework(opt)}
                          className={`px-3.5 py-2 rounded-xl text-xs font-medium transition-all ${
                            selected
                              ? "border-2 border-neutral-900 bg-neutral-50 text-neutral-900"
                              : "border border-neutral-200 bg-white text-neutral-600 hover:border-neutral-300"
                          }`}
                        >
                          {opt}
                        </button>
                      );
                    })}
                  </div>
                  {psychFramework === "אחר" && (
                    <input
                      type="text"
                      placeholder="ציינו את מסגרת הלמידה"
                      value={psychFrameworkOther}
                      onChange={(e) => setPsychFrameworkOther(e.target.value)}
                      className={`${fieldClass} text-xs`}
                    />
                  )}
                </div>
              ) : (
                <div>
                  <label className={labelClass} htmlFor="f-school">
                    שם בית ספר / מכללה / אוניברסיטה / יחידה
                  </label>
                  <input
                    id="f-school"
                    type="text"
                    placeholder="לדוגמה: תיכון הריאלי חיפה, אוניברסיטת תל אביב, מכינת הטכניון"
                    value={schoolName}
                    onChange={(e) => setSchoolName(e.target.value)}
                    className={`${fieldClass} text-xs`}
                  />
                </div>
              )}

              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-neutral-500 mb-1 text-start" htmlFor="f-sname">
                    שם התלמיד/ה <span className="text-rose-500">*</span>
                  </label>
                  <input
                    id="f-sname"
                    type="text"
                    required
                    placeholder="לדוגמה: יונתן כהן"
                    value={studentName}
                    onChange={(e) => setStudentName(e.target.value)}
                    className={fieldClassSm}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-neutral-500 mb-1 text-start" htmlFor="f-sphone">
                    טלפון תלמיד/ה <span className="text-rose-500">*</span>
                  </label>
                  <input
                    id="f-sphone"
                    type="tel"
                    required
                    placeholder="050-0000000"
                    value={studentPhone}
                    onChange={(e) => setStudentPhone(e.target.value)}
                    className={fieldClassSm}
                  />
                </div>
              </div>

              {!isPsychometric && (
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-neutral-500 mb-1 text-start" htmlFor="f-pname">
                      שם ההורה (למעקב משותף)
                    </label>
                    <input
                      id="f-pname"
                      type="text"
                      placeholder="לדוגמה: רונית כהן"
                      value={parentName}
                      onChange={(e) => setParentName(e.target.value)}
                      className={fieldClassSm}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-neutral-500 mb-1 text-start" htmlFor="f-pphone">
                      WhatsApp הורה לקבלת סיכומי שיעור
                    </label>
                    <input
                      id="f-pphone"
                      type="tel"
                      placeholder="052-0000000"
                      value={parentPhone}
                      onChange={(e) => setParentPhone(e.target.value)}
                      className={fieldClassSm}
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={() => setMicroStep(2)}
                className={backBtnClass}
              >
                חזרה
                <ArrowRight className="ms-2" />
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!studentName.trim() || !studentPhone.trim()) {
                    toast.error("נא למלא שם וטלפון תלמיד/ה");
                    return;
                  }
                  if (isPsychometric && !psychFramework) {
                    toast.error("נא לבחור מסגרת למידה");
                    return;
                  }
                  if (isPsychometric && psychFramework === "אחר" && !psychFrameworkOther.trim()) {
                    toast.error("נא לציין את מסגרת הלמידה");
                    return;
                  }
                  setMicroStep(4);
                }}
                className={proceedBtnClass}
              >
                <ArrowLeft className="me-2" />
                המשך לקביעת יעד ודחיפות
              </button>
            </div>
          </section>
        )}

        {/* MICRO-STEP 4: URGENCY, GOAL & BASELINE */}
        {microStep === 4 && (
          <section className={`${frostCard} p-6 sm:p-8 space-y-6`}>
            <div className="text-start">
              <span className={eyebrowClass}>שלב 4: מטרות ודחיפות</span>
              <h2 className="text-2xl font-semibold tracking-tight text-neutral-900 mt-1 [text-wrap:balance]">
                מתי המבחן הקרוב ומה ציון היעד?
              </h2>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-neutral-600 mb-2 text-start">דחיפות לוח זמנים</label>
                <div className="space-y-2">
                  {EXAM_TIMEFRAMES.map((tf) => {
                    const isSelected = selectedTimeframe === tf.id;
                    return (
                      <button
                        key={tf.id}
                        type="button"
                        onClick={() => setSelectedTimeframe(tf.id)}
                        className={`${choiceCardClass(isSelected)} text-xs font-medium`}
                      >
                        <span className={checkDotClass(isSelected)}>{isSelected ? "✓" : ""}</span>
                        <span className={`flex-1 ps-3 text-start ${isSelected ? "text-neutral-900" : "text-neutral-600"}`}>
                          {tf.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-neutral-600 mb-2 text-start">מטרת העל שלכם</label>
                <div className="space-y-2">
                  {LEARNING_GOALS.map((g) => {
                    const isSelected = learningGoal === g.id;
                    return (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() => setLearningGoal(g.id)}
                        className={choiceCardClass(isSelected)}
                      >
                        <span className={checkDotClass(isSelected)}>{isSelected ? "✓" : ""}</span>
                        <div className="flex-1 ps-3 text-start">
                          <span className="text-xs font-semibold text-neutral-900 block">{g.title}</span>
                          <span className="text-[11px] text-neutral-500 font-medium block mt-0.5">{g.desc}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                {isPsychometric ? (
                  <div className="space-y-3">
                    <label className="block text-xs font-medium text-neutral-600 mb-2 text-start">
                      ציוני סימולציה אחרונה / מבחן קודם
                    </label>
                    <label className="flex items-center gap-2.5 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={isFirstPsychometric}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setIsFirstPsychometric(checked);
                          setPsychometricScores((prev) => ({
                            ...prev,
                            isFirstTime: checked,
                            quantitative: checked ? undefined : prevPsychQuant,
                            verbal: checked ? undefined : prevPsychVerbal,
                            english: checked ? undefined : prevPsychEnglish,
                          }));
                        }}
                        className="w-4 h-4 rounded border-neutral-300 text-neutral-900 focus:ring-neutral-900/20"
                      />
                      <span className="text-xs font-medium text-neutral-700">
                        עדיין לא נבחנתי / אין לי ציון קודם
                      </span>
                    </label>

                    {!isFirstPsychometric && (
                      <div className="bg-neutral-50 border border-neutral-200 p-4 rounded-2xl space-y-3">
                        <div className="grid sm:grid-cols-3 gap-3">
                          <div>
                            <label className="block text-[11px] font-medium text-neutral-500 mb-1 text-start">
                              חשיבה כמותית
                            </label>
                            <input
                              type="number"
                              min={50}
                              max={150}
                              value={prevPsychQuant}
                              onChange={(e) => {
                                const val = Number(e.target.value);
                                setPrevPsychQuant(val);
                                setPsychometricScores((prev) => ({
                                  ...prev,
                                  isFirstTime: false,
                                  quantitative: val,
                                }));
                              }}
                              className="w-full bg-white border border-neutral-200 rounded-xl p-2.5 text-sm font-mono text-center focus:outline-none focus:ring-2 focus:ring-neutral-900/10"
                            />
                            {isPsychometricScoreOutOfRange(prevPsychQuant) && (
                              <p className="mt-1 text-[11px] text-amber-600 text-start">
                                מומלץ טווח 50–150
                              </p>
                            )}
                          </div>
                          <div>
                            <label className="block text-[11px] font-medium text-neutral-500 mb-1 text-start">
                              חשיבה מילולית
                            </label>
                            <input
                              type="number"
                              min={50}
                              max={150}
                              value={prevPsychVerbal}
                              onChange={(e) => {
                                const val = Number(e.target.value);
                                setPrevPsychVerbal(val);
                                setPsychometricScores((prev) => ({
                                  ...prev,
                                  isFirstTime: false,
                                  verbal: val,
                                }));
                              }}
                              className="w-full bg-white border border-neutral-200 rounded-xl p-2.5 text-sm font-mono text-center focus:outline-none focus:ring-2 focus:ring-neutral-900/10"
                            />
                            {isPsychometricScoreOutOfRange(prevPsychVerbal) && (
                              <p className="mt-1 text-[11px] text-amber-600 text-start">
                                מומלץ טווח 50–150
                              </p>
                            )}
                          </div>
                          <div>
                            <label className="block text-[11px] font-medium text-neutral-500 mb-1 text-start">
                              אנגלית
                            </label>
                            <input
                              type="number"
                              min={50}
                              max={150}
                              value={prevPsychEnglish}
                              onChange={(e) => {
                                const val = Number(e.target.value);
                                setPrevPsychEnglish(val);
                                setPsychometricScores((prev) => ({
                                  ...prev,
                                  isFirstTime: false,
                                  english: val,
                                }));
                              }}
                              className="w-full bg-white border border-neutral-200 rounded-xl p-2.5 text-sm font-mono text-center focus:outline-none focus:ring-2 focus:ring-neutral-900/10"
                            />
                            {isPsychometricScoreOutOfRange(prevPsychEnglish) && (
                              <p className="mt-1 text-[11px] text-amber-600 text-start">
                                מומלץ טווח 50–150
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    <label className="block text-xs font-medium text-neutral-600 mb-2 text-start">
                      ציון אחרון במקצוע / ציון בסיס נוכחי: {lastGrade}
                    </label>
                    <div className="bg-neutral-50 border border-neutral-200 p-4 rounded-2xl space-y-2">
                      <input
                        type="range"
                        min={30}
                        max={100}
                        value={lastGrade}
                        onChange={(e) => setLastGrade(Number(e.target.value))}
                        className="w-full accent-neutral-900 cursor-pointer"
                      />
                      <div className="flex justify-between text-[11px] text-neutral-400 font-medium">
                        <span>30 (פער עמוק)</span>
                        <span>65 (בינוני)</span>
                        <span>100 (מצוינות)</span>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={() => setMicroStep(3)}
                className={backBtnClass}
              >
                חזרה
                <ArrowRight className="ms-2" />
              </button>
              <button
                type="button"
                onClick={() => setMicroStep(5)}
                className={proceedBtnClass}
              >
                <ArrowLeft className="me-2" />
                מעבר לשאלות העומק
              </button>
            </div>
          </section>
        )}

        {/* MICRO-STEP 5: 3-DOMAIN QUESTIONS (+ optional English writing) */}
        {microStep === 5 && activeQuestion && !showEnglishWriting && (
          <section className={`${frostCard} p-6 sm:p-8 space-y-6`}>
            <div className="flex items-center justify-between">
              <span className={`${trackBadge} text-neutral-700`}>
                שאלת עומק {currentQuestionIdx + 1} מתוך {challengeQuestions.length}:{" "}
                {activeTrack === "MECHINA"
                  ? getMechinaBadgeLabel(mechinaSubject)
                  : getBadgeDisplayLabel(activeQuestion)}
              </span>
              <span className="text-xs font-mono font-medium text-neutral-400">
                שאלה {currentQuestionIdx + 1} / {challengeQuestions.length}
              </span>
            </div>

            <div className="text-right">
              <h2 className="text-xl sm:text-2xl font-semibold tracking-tight text-neutral-900 [text-wrap:balance]">
                {activeQuestion.title}
              </h2>
            </div>

            <div className="bg-neutral-50 border border-neutral-200 rounded-2xl p-5 space-y-3 text-right">
              {activeQuestion.context && (
                <div className="rounded-xl bg-white border border-neutral-200 px-4 py-3 text-right">
                  <p
                    className={`text-sm leading-relaxed text-neutral-700 whitespace-pre-wrap font-medium ${
                      isEnglishBagrut ? "text-left" : "text-right"
                    }`}
                    dir={isEnglishBagrut ? "ltr" : "rtl"}
                  >
                    <DiagnosticMathText text={activeQuestion.context} />
                  </p>
                </div>
              )}
              <p className="text-sm font-medium text-neutral-800 text-right" dir="rtl">
                <DiagnosticMathText text={activeQuestion.instruction} />
              </p>
              {activeQuestion.formulaLatex && (
                <FormulaDisplay
                  latex={activeQuestion.formulaLatex}
                  className="text-base sm:text-lg text-neutral-800"
                />
              )}
            </div>

            <div className="space-y-3">
              {activeQuestion.options.map((opt) => {
                const isSelected = answers[activeQuestion.id] === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => handleSelectOption(activeQuestion.id, opt.id)}
                    className={choiceCardClass(isSelected)}
                  >
                    {/* Radio first in DOM → appears at RTL start (right) */}
                    <span className={checkDotClass(isSelected)}>
                      {isSelected && "✓"}
                    </span>
                    <div className="min-w-0 flex-1 text-right">
                      {opt.plainText ? (
                        <span
                          className={`text-sm font-medium text-neutral-800 ${
                            isEnglishBagrut ? "block text-left" : "block text-right"
                          }`}
                          dir={isEnglishBagrut ? "ltr" : "rtl"}
                        >
                          <DiagnosticMathText text={opt.plainText} />
                        </span>
                      ) : opt.mathText ? (
                        <DiagnosticMathText
                          text={`$${opt.mathText}$`}
                          className="text-sm font-medium text-neutral-800 text-right"
                        />
                      ) : null}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="flex gap-3 pt-2">
              {currentQuestionIdx > 0 ? (
                <button
                  type="button"
                  onClick={handlePrevQuestion}
                  className={backBtnClass}
                >
                  שאלה קודמת
                  <ArrowRight className="ms-2" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setMicroStep(4)}
                  className={backBtnClass}
                >
                  חזרה
                  <ArrowRight className="ms-2" />
                </button>
              )}

              {currentQuestionIdx < challengeQuestions.length - 1 ? (
                <button
                  type="button"
                  disabled={!answers[activeQuestion.id]}
                  onClick={handleNextQuestion}
                  className={proceedBtnClass}
                >
                  <ArrowLeft className="me-2" />
                  שאלה הבאה
                </button>
              ) : isEnglishBagrut ? (
                <button
                  type="button"
                  disabled={!answers[activeQuestion.id]}
                  onClick={() => setShowEnglishWriting(true)}
                  className={proceedBtnClass}
                >
                  <ArrowLeft className="me-2" />
                  המשך למשימת כתיבה
                </button>
              ) : (
                <button
                  type="button"
                  disabled={loading || !answers[activeQuestion.id]}
                  onClick={() => void handleSubmitDiagnostic()}
                  className={proceedBtnClass}
                >
                  <ArrowLeft className="me-2" />
                  {loading ? "מחשב מדד מוכנות..." : "חשב מדד מוכנות למבחן"}
                </button>
              )}
            </div>
          </section>
        )}

        {microStep === 5 && isEnglishBagrut && showEnglishWriting && englishWritingPrompt && (
          <section className={`${frostCard} p-6 sm:p-8 space-y-6`}>
            <div className="text-start space-y-2">
              <span className={trackBadge}>משימת כתיבה (רשות להערכה מורחבת)</span>
              <h2 className="text-xl sm:text-2xl font-semibold tracking-tight text-neutral-900 [text-wrap:balance]">
                {englishWritingPrompt.title}
              </h2>
              <p className="text-xs font-medium text-neutral-500">
                אופציונלי — ניתן לדלג ולהמשיך לחישוב מדד המוכנות
              </p>
            </div>

            <div className="bg-neutral-50 border border-neutral-200 rounded-2xl p-5 space-y-3 text-start">
              <p
                className="text-sm font-medium text-neutral-900 leading-relaxed text-left"
                dir="ltr"
              >
                {englishWritingPrompt.topic}
              </p>
              <p className="text-xs text-neutral-600 leading-relaxed text-left" dir="ltr">
                {englishWritingPrompt.instructions}
              </p>
            </div>

            <div className="space-y-2">
              <label className={labelClass} htmlFor="english-writing">
                חיבור באנגלית
              </label>
              <textarea
                id="english-writing"
                dir="ltr"
                rows={8}
                value={englishWritingText}
                onChange={(e) => setEnglishWritingText(e.target.value)}
                placeholder="Write your composition here..."
                className={`${fieldClass} text-sm text-left font-medium min-h-[180px] resize-y`}
              />
              <div className="flex items-center justify-between text-xs font-medium text-neutral-500">
                <span dir="ltr" className="tabular-nums">
                  Word count: {englishWordCount}
                </span>
                <span dir="ltr" className="tabular-nums">
                  Target: {englishWritingPrompt.minWords}–{englishWritingPrompt.maxWords}
                </span>
              </div>
              {englishWordCount > 0 &&
                (englishWordCount < englishWritingPrompt.minWords ||
                  englishWordCount > englishWritingPrompt.maxWords) && (
                  <p className="text-[11px] text-amber-600 text-start">
                    מומלץ לעמוד בטווח המילים של הבחינה — המשימה עדיין רשות.
                  </p>
                )}
            </div>

            <div className="flex gap-3 pt-2 flex-wrap">
              <button
                type="button"
                onClick={handlePrevQuestion}
                className={backBtnClass}
              >
                חזרה לשאלות
                <ArrowRight className="ms-2" />
              </button>
              <button
                type="button"
                disabled={loading}
                onClick={() => void handleSubmitDiagnostic({ skipWriting: true })}
                className={`${secondaryCta} flex-1 inline-flex items-center justify-center gap-2 text-sm`}
              >
                דלג על הכתיבה
              </button>
              <button
                type="button"
                disabled={loading}
                onClick={() => void handleSubmitDiagnostic()}
                className={proceedBtnClass}
              >
                <ArrowLeft className="me-2" />
                {loading ? "מחשב מדד מוכנות..." : "חשב מדד מוכנות למבחן"}
              </button>
            </div>
          </section>
        )}

        {/* MICRO-STEP 6: TEASER PAYWALL — readiness + sample insight + locked gaps */}
        {microStep === 6 && teaserData && (
          <section className="space-y-6">
            <div className={`${frostCard} p-6 sm:p-8 space-y-4`}>
              <div className="text-start">
                <span className={trackBadge}>מדד מוכנות</span>
                <h2 className="text-xl sm:text-2xl font-semibold tracking-tight text-neutral-900 mt-2 text-start [text-wrap:balance]">
                  <span className="tabular-nums">{teaserData.estimatedScore}%</span> מדד מוכנות נוכחי
                </h2>
              </div>

              <div className="flex items-center justify-center my-2">
                <div className="relative w-40 h-40 rounded-full border border-white/70 flex items-center justify-center liquid-glass">
                  <div className="text-center">
                    <span className="text-4xl sm:text-5xl font-semibold tracking-tight text-neutral-900">
                      {teaserData.estimatedScore}%
                    </span>
                    <span className="block text-[10px] font-medium text-neutral-500 tracking-widest mt-1">
                      מדד מוכנות נוכחי
                    </span>
                  </div>
                </div>
              </div>

              {teaserData.readinessBadge && (
                <div className="flex justify-center">
                  <span
                    className={`inline-flex items-center rounded-full border px-4 py-1.5 text-sm font-semibold ${readinessBadgeClass(teaserData.readinessBadge.tone)}`}
                  >
                    {teaserData.readinessBadge.label}
                  </span>
                </div>
              )}

              {teaserData.recommendationSummary && (
                <p className="text-sm font-medium text-neutral-700 leading-relaxed text-start max-w-xl mx-auto">
                  {teaserData.recommendationSummary}
                </p>
              )}
            </div>

            {teaserData.sampleExplanation && (
              <div className={`${frostCard} relative z-10 p-6 sm:p-8 space-y-4 ring-1 ring-emerald-500/15 shadow-[0_12px_40px_-16px_rgba(16,185,129,0.25)]`}>
                <div className="text-start space-y-2">
                  <span className="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-50 px-3.5 py-1 text-xs font-semibold text-emerald-800 tracking-wide">
                    הצצה לדו״ח המלא · דוגמת ניתוח פדגוגי
                  </span>
                  <h3 className="text-lg font-semibold text-neutral-900 text-start mt-1">
                    ניתוח שאלה לדוגמה — {teaserData.sampleExplanation.topicLabel}
                  </h3>
                  <p className="text-xs text-neutral-500 font-medium text-start">
                    הצצה חדה לאיכות ההסבר. שאר מוקדי הפער מעומעמים ונעולים למטה.
                  </p>
                </div>

                <div className="rounded-2xl border border-emerald-500/20 bg-neutral-50/90 p-4 sm:p-5 space-y-3 text-start">
                  <h4 className="text-sm font-semibold text-neutral-900">
                    {teaserData.sampleExplanation.title}
                  </h4>
                  {teaserData.sampleExplanation.context && (
                    <p className="text-sm text-neutral-700 leading-relaxed">
                      <DiagnosticMathText text={teaserData.sampleExplanation.context} />
                    </p>
                  )}
                  {teaserData.sampleExplanation.instruction && (
                    <p className="text-sm font-medium text-neutral-800">
                      <DiagnosticMathText text={teaserData.sampleExplanation.instruction} />
                    </p>
                  )}
                  {teaserData.sampleExplanation.formulaLatex && (
                    <div className="rounded-xl border border-emerald-500/20 bg-neutral-100/50 px-3 py-2">
                      <FormulaDisplay latex={teaserData.sampleExplanation.formulaLatex} />
                    </div>
                  )}

                  <div
                    className={`rounded-xl border px-3.5 py-2.5 text-sm ${
                      teaserData.sampleExplanation.isCorrect
                        ? "border-emerald-200 bg-emerald-50/80 text-emerald-900"
                        : "border-rose-200 bg-rose-50/80 text-rose-900"
                    }`}
                  >
                    <span className="font-semibold">
                      {teaserData.sampleExplanation.isCorrect ? "התשובה שסימנת (נכונה): " : "התשובה שסימנת: "}
                    </span>
                    <DiagnosticMathText text={teaserData.sampleExplanation.selectedText} />
                  </div>

                  {!teaserData.sampleExplanation.isCorrect && teaserData.sampleExplanation.correctText && (
                    <div className="rounded-xl border border-emerald-200 bg-emerald-50/80 px-3.5 py-2.5 text-sm text-emerald-900">
                      <span className="font-semibold">התשובה הנכונה: </span>
                      <DiagnosticMathText text={teaserData.sampleExplanation.correctText} />
                    </div>
                  )}

                  {teaserData.sampleExplanation.explanation && (
                    <div className="rounded-xl border border-emerald-500/20 bg-white px-3.5 py-3 text-sm text-neutral-800 leading-relaxed">
                      <span className="font-semibold text-neutral-900 block mb-1">הסבר פדגוגי:</span>
                      <DiagnosticMathText text={teaserData.sampleExplanation.explanation} />
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Locked pedagogical vault — frosted underlay + floating glass lock */}
            <div className={`${frostCard} p-4 sm:p-6 space-y-3`}>
              <div className="text-start px-1">
                <h3 className="text-lg font-semibold text-neutral-900 text-start">עץ פערי ידע ומשוב מלא</h3>
                <p className="text-xs font-medium text-neutral-500 mt-0.5 text-start">
                  התוכן למטה מעומעם בכוונה — יש שם ניתוח עשיר שממתין לשחרור
                </p>
              </div>

              <div className="relative overflow-hidden rounded-2xl border border-neutral-200/80 min-h-[420px]">
                {/* Underlay: rich skeleton (blurred + fade mask) */}
                <div
                  className="select-none pointer-events-none filter blur-[6px] opacity-35 transition-all duration-500 p-4 sm:p-5 space-y-4"
                  aria-hidden="true"
                  style={{
                    maskImage:
                      "linear-gradient(to bottom, rgba(0,0,0,0.8) 0%, rgba(0,0,0,0.3) 50%, transparent 100%)",
                    WebkitMaskImage:
                      "linear-gradient(to bottom, rgba(0,0,0,0.8) 0%, rgba(0,0,0,0.3) 50%, transparent 100%)",
                  }}
                >
                  {/* Two additional diagnostic question previews */}
                  {[
                    {
                      id: "locked-q-a",
                      title: "שאלה 2 — ניתוח גבולות וחקירת פונקציה",
                      lines: ["נתון גרף והתנהגות בקצוות…", "מהי מסקנת החקירה המלאה?"],
                    },
                    {
                      id: "locked-q-b",
                      title: "שאלה 3 — יישום ברמת בחינה",
                      lines: ["נתונה מערכת תנאים ופרמטר…", "איזו אפשרות מתאימה לפתרון המלא?"],
                    },
                  ].map((q) => (
                    <div
                      key={q.id}
                      className="rounded-2xl border border-neutral-200/90 bg-white/90 p-4 space-y-2.5 text-start"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-neutral-800">{q.title}</span>
                        <span className="h-5 w-14 rounded-full bg-neutral-200/90" />
                      </div>
                      {q.lines.map((line) => (
                        <p key={line} className="text-xs text-neutral-600 leading-relaxed">
                          {line}
                        </p>
                      ))}
                      <div className="grid gap-2 pt-1">
                        <span className="h-8 w-full rounded-lg bg-neutral-100 border border-neutral-200/80" />
                        <span className="h-8 w-[92%] rounded-lg bg-neutral-100 border border-neutral-200/80" />
                        <span className="h-16 w-full rounded-xl bg-emerald-50/80 border border-emerald-200/60" />
                      </div>
                    </div>
                  ))}

                  {/* Pedagogical gap tree skeleton */}
                  <div className="space-y-3 pt-1">
                    <p className="text-xs font-semibold text-neutral-700 text-start">מפת מוקדי הפער</p>
                    {(teaserData.maskedTopics && teaserData.maskedTopics.length > 0
                      ? teaserData.maskedTopics
                      : ([
                          { id: "gap-a", maskedName: "מוקד פער א׳", weightInExam: 0.22, subTopicsCount: 3, isLocked: true },
                          { id: "gap-b", maskedName: "מוקד פער ב׳", weightInExam: 0.18, subTopicsCount: 2, isLocked: true },
                          { id: "gap-c", maskedName: "מוקד פער ג׳", weightInExam: 0.15, subTopicsCount: 4, isLocked: true },
                        ] as MaskedTopic[])
                    ).map((t) => (
                      <div
                        key={t.id}
                        className="rounded-2xl border border-neutral-200/90 bg-white/90 p-4 space-y-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-neutral-800 text-start">
                            {t.maskedName}
                          </span>
                          <span className={trackBadge}>
                            {Math.round(t.weightInExam * 100)}% משקל בבחינה
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-2 justify-start">
                          <span className="h-4 w-28 bg-neutral-100 rounded-md" />
                          <span className="h-4 w-36 bg-neutral-100 rounded-md" />
                          <span className="h-4 w-20 bg-neutral-100 rounded-md" />
                        </div>
                        {typeof t.subTopicsCount === "number" && t.subTopicsCount > 0 && (
                          <p className="text-[11px] text-neutral-500 font-medium text-start">
                            {t.subTopicsCount} תתי־נושאים · הסברים מפורטים · התאמת מורה
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Floating glassmorphic lock overlay */}
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center p-4 sm:p-6 bg-white/40 backdrop-blur-[2px]">
                  <div className="max-w-md w-full mx-auto p-6 rounded-2xl bg-white/90 border border-neutral-200/80 shadow-2xl backdrop-blur-xl text-center space-y-4">
                    <div className="w-14 h-14 mx-auto rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-600 shadow-inner">
                      <LockIcon className="w-6 h-6 animate-pulse" />
                    </div>

                    <div className="space-y-1.5">
                      <h4 className="text-lg font-bold text-neutral-900 tracking-tight">
                        מיפוי פערי הידע המלא ומפת הדרכים נעולים
                      </h4>
                      <p className="text-xs sm:text-sm text-neutral-600 font-medium leading-relaxed">
                        2 שאלות אבחון נוספות, פתרונות מפורטים ועץ נושאי הליבה ממתינים לשחרור
                      </p>
                    </div>

                    {teaserData.paywallNotice && (
                      <div className="p-3 rounded-xl bg-neutral-100/80 border border-neutral-200/70 text-xs text-neutral-600 font-medium leading-relaxed text-start">
                        {teaserData.paywallNotice}
                      </div>
                    )}

                    <div className="space-y-2 pt-1">
                      <p className="text-[11px] text-neutral-500 font-medium">
                        {recommendedPackage === "MULTI"
                          ? "מומלץ: חבילת MULTI — 5 שיעורים · ₪850"
                          : "מומלץ: חבילת TRIO — 3 שיעורים · ₪540"}
                      </p>
                      <Link
                        href={pricingHref}
                        onClick={() => {
                          if (teaserData?.id) {
                            persistPendingDiagnostic({
                              quizId: teaserData.id,
                              packageRecommendation: recommendedPackage,
                            });
                          }
                        }}
                        className={`${primaryCta} inline-flex w-full h-11 items-center justify-center gap-2 text-sm font-semibold shadow-lg hover:shadow-neutral-900/20 transition-all`}
                      >
                        <ArrowLeft className="me-1" />
                        שחרור הדו״ח המלא והתאמת מורה
                      </Link>
                      <p className="text-[10px] text-neutral-400 font-medium">
                        {recommendedLessons} שיעורים · ללא שיבוץ לפני תשלום
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* MICRO-STEP 7: UNLOCKED KNOWLEDGE TREE + FULL EXAM REVIEW */}
        {microStep === 7 && teaserData && (
          <section className="space-y-6">
            <div className={`${frostCard} p-6 sm:p-8 space-y-6`}>
              <div className="border-b border-neutral-200/80 pb-5 text-start">
                <h2 className="text-2xl font-semibold tracking-tight text-neutral-900 [text-wrap:balance]">
                  עץ פערי ידע מלא — {getDerivedSubject()}
                </h2>
                <p className="text-xs text-neutral-500 font-medium mt-1">
                  {teaserData.estimatedScore}% מדד מוכנות
                  {teaserData.readinessBadge ? ` · ${teaserData.readinessBadge.label}` : ""}
                </p>
              </div>

              {teaserData.matchedTeacher && (
                <div className="bg-neutral-900/[0.03] border border-neutral-900/[0.08] rounded-2xl p-5 space-y-3">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-3">
                      <span className="w-10 h-10 rounded-full bg-neutral-900 text-white flex items-center justify-center text-xs font-medium">
                        מ
                      </span>
                      <div className="text-start">
                        <h4 className="text-sm font-semibold text-neutral-900">
                          המורה המומחה שלך: {teaserData.matchedTeacher.teacherName}
                        </h4>
                        <p className="text-xs text-neutral-500 font-medium">
                          ציון התאמה פדגוגי: {teaserData.matchedTeacher.matchScore}% · {teaserData.matchedTeacher.openSlotsCount} משבצות פנויות
                        </p>
                      </div>
                    </div>

                    {teaserData.quadGroupUrl && (
                      <a
                        href={teaserData.quadGroupUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`${primaryCta} text-xs py-2 px-4`}
                      >
                        כניסה לקבוצת הווטסאפ המרובעת
                      </a>
                    )}
                  </div>

                  {teaserData.matchedTeacher.reasons.length > 0 && (
                    <div className="flex flex-wrap gap-2 justify-start pt-1">
                      {teaserData.matchedTeacher.reasons.map((r, i) => (
                        <span key={i} className={trackBadge}>
                          {r}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-neutral-700 text-start">נושאי מיקוד הדורשים ליטוש:</h3>
                {teaserData.topics && teaserData.topics.length > 0 ? (
                  teaserData.topics.map((t) => (
                    <div
                      key={t.id}
                      className={`${frostCard} p-4 space-y-2`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <h4 className="text-sm font-semibold text-neutral-900 text-start">{t.topicName}</h4>
                        <span className={trackBadge}>
                          {Math.round(t.weightInExam * 100)}% משקל בבחינה
                        </span>
                      </div>

                      {Array.isArray(t.subTopics) && t.subTopics.length > 0 && (
                        <div className="flex flex-wrap gap-2 justify-start">
                          {t.subTopics.map((sub: string, i: number) => (
                            <span key={i} className={trackBadge}>
                              {sub}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))
                ) : (
                  <div className="py-6 text-neutral-400 text-xs font-medium text-start">
                    לא זוהו נושאים ספציפיים במערכת — המורה המומחה יבצע מיפוי פרטני בשיעור הראשון.
                  </div>
                )}
              </div>
            </div>

            <div className={`${frostCard} p-6 sm:p-8 space-y-5`}>
              <div className="text-start border-b border-neutral-200/80 pb-4">
                <span className={trackBadge}>סקירת מבחן מלאה</span>
                <h3 className="text-lg sm:text-xl font-semibold tracking-tight text-neutral-900 mt-2">
                  פירוט השאלות, התשובות וההסברים
                </h3>
              </div>

              <div className="space-y-4">
                {(teaserData.questionReviews && teaserData.questionReviews.length > 0
                  ? teaserData.questionReviews
                  : challengeQuestions.map((q) => {
                      const selectedOptId = answers[q.id];
                      const opt = q.options.find((o) => o.id === selectedOptId);
                      const correctOpt = q.options.find((o) => o.isCorrect);
                      return {
                        questionId: q.id,
                        topicLabel: extractPedagogicalTopic(q.title),
                        title: q.title,
                        context: q.context,
                        instruction: q.instruction,
                        formulaLatex: q.formulaLatex,
                        selectedOptionId: selectedOptId || "",
                        selectedText: optionDisplayText(opt) || "לא נענה",
                        isCorrect: !!opt?.isCorrect,
                        correctOptionId: correctOpt?.id || "",
                        correctText: optionDisplayText(correctOpt),
                        explanation: correctOpt?.explanation || "",
                      } satisfies QuestionReviewItem;
                    })
                ).map((review, idx) => (
                  <div
                    key={review.questionId}
                    className="rounded-2xl border border-neutral-200 bg-neutral-50/60 p-4 sm:p-5 space-y-3 text-start"
                  >
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <h4 className="text-sm font-semibold text-neutral-900">
                        שאלה {idx + 1}: {review.title}
                      </h4>
                      <span
                        className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${
                          review.isCorrect
                            ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                            : "bg-rose-50 border-rose-200 text-rose-800"
                        }`}
                      >
                        {review.isCorrect ? "נכון" : "טעון תיקון"}
                      </span>
                    </div>

                    {review.context && (
                      <p className="text-sm text-neutral-700 leading-relaxed">
                        <DiagnosticMathText text={review.context} />
                      </p>
                    )}
                    {review.instruction && (
                      <p className="text-sm font-medium text-neutral-800">
                        <DiagnosticMathText text={review.instruction} />
                      </p>
                    )}
                    {review.formulaLatex && <FormulaDisplay latex={review.formulaLatex} />}

                    <div
                      className={`rounded-xl border px-3.5 py-2.5 text-sm ${
                        review.isCorrect
                          ? "border-emerald-200 bg-emerald-50/80 text-emerald-900"
                          : "border-rose-200 bg-rose-50/80 text-rose-900"
                      }`}
                    >
                      <span className="font-semibold">התשובה שסימנת: </span>
                      <DiagnosticMathText text={review.selectedText} />
                    </div>

                    <div className="rounded-xl border border-emerald-200 bg-emerald-50/80 px-3.5 py-2.5 text-sm text-emerald-900">
                      <span className="font-semibold">התשובה הנכונה: </span>
                      <DiagnosticMathText text={review.correctText} />
                    </div>

                    {review.explanation && (
                      <div className="rounded-xl border border-neutral-200 bg-white px-3.5 py-3 text-sm text-neutral-800 leading-relaxed">
                        <span className="font-semibold text-neutral-900 block mb-1">הסבר פדגוגי:</span>
                        <DiagnosticMathText text={review.explanation} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
