"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "react-hot-toast";
import TeacherOnboardingTimeline from "../../components/TeacherOnboardingTimeline";
import LessonRow from "../../components/LessonRow";
import BrandWordmark from "../../components/BrandWordmark";
import WeeklyScheduleBoard from "../../components/WeeklyScheduleBoard";
import StudentTimePreferenceBar, {
  type StudentTimePreference,
  hasActiveTimePreference,
} from "../../components/StudentTimePreferenceBar";
import { ACTIVITY_HOUR_SLOTS } from "../../lib/matching";
import type { TeacherOnboardingStatus } from "../../lib/teacher-onboarding";
import {
  badgeNeutral,
  badgeSuccess,
  badgeWarning,
  emptyState,
  eyebrow,
  fieldClass,
  frostCard,
  pageCanvas,
  primaryCta,
  secondaryCta,
} from "../../lib/ui";

function emptyTimePreference(): StudentTimePreference {
  return { requestedDays: [], requestedTimes: [], timeWindows: [] };
}

/** Expand selected windows + discrete hours into HH:00 labels for board highlight. */
function preferenceHighlightHours(pref: StudentTimePreference): string[] {
  const hours = new Set<string>(pref.requestedTimes);
  for (const w of pref.timeWindows) {
    const startH = parseInt(w.start.split(":")[0] ?? "0", 10);
    const endH = parseInt(w.end.split(":")[0] ?? "0", 10);
    for (const label of ACTIVITY_HOUR_SLOTS) {
      const h = parseInt(label.split(":")[0] ?? "0", 10);
      if (h >= Math.min(startH, endH) && h <= Math.max(startH, endH)) {
        hours.add(label);
      }
    }
  }
  return [...hours].sort();
}

/** Keys must match the reason strings emitted by `lib/matching.ts`; unmapped (ranking/load) reasons stay internal. */
const STUDENT_REASON_COPY: Record<string, string> = {
  "התאמת מקצוע גבוהה": "מתמחה במקצוע שלך",
  "התאמת מקצוע חלקית": "מלמד תחומים קרובים",
  "התאמת חומר לימוד": "מכיר את החומר שביקשת",
  "התאמת רמת לימוד / קבוצת גיל": "מלמד בשכבת הגיל שלך",
};

function studentFacingReasons(reasons: string[]): string[] {
  return reasons.flatMap((r) => (STUDENT_REASON_COPY[r] ? [STUDENT_REASON_COPY[r]] : []));
}

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

interface LoggedInUser {
  id: string;
  name: string;
  role: "STUDENT" | "TEACHER" | "ADMIN" | "MANAGER";
  lessonCredits: number;
  isApproved: boolean;
}

interface AvailabilitySlot {
  id: string;
  startTime: string;
  endTime: string;
  isBooked: boolean;
}

interface OpenBookingSlot extends AvailabilitySlot {
  teacher: {
    id: string;
    name: string;
    teacherProfile?: {
      subjects: string[];
      ageGroups?: string[];
      bio: string | null;
    } | null;
  };
}

interface Lesson {
  id: string;
  title: string | null;
  scheduledAt: string;
  status: string;
  canceledById?: string;
  teacherId: string;
  appealStatus?: string;
  teacher: { id: string; name: string };
  student: { id: string; name: string };
}

interface TeacherMatch {
  teacherId: string;
  teacherName: string;
  matchScore: number;
  subjectFitScore?: number;
  levelFitScore?: number;
  availabilityScore?: number;
  isSoftRecommendation?: boolean;
  exactAvailabilityMatch?: boolean;
  overlapCount?: number;
  matchedHighlightDays?: number[];
  matchedHighlightHours?: string[];
  nearestSlotStart?: string | null;
  nearestSlotDeltaMinutes?: number | null;
  weeklyLessonCount?: number;
  reasons: string[];
  referralCount: number;
  activeStudentsCount: number;
  openSlotsCount: number;
  bio: string | null;
  subjects: string[];
  ageGroups: string[];
}

interface TeacherProfileForm {
  subjectsText: string;
  ageGroups: string[];
  bio: string;
  profileImageUrl: string;
  bankName: string;
  bankBranch: string;
  accountNumber: string;
  accountHolderName: string;
  referralCount: number;
  activeStudentsCount: number;
  lastReferralAt: string | null;
}

const AGE_GROUP_OPTIONS = ["יסודי", "חטיבה", "תיכון", "אקדמיה"] as const;

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<LoggedInUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [purchaseLoading, setPurchaseLoading] = useState(false);
  const [availLoading, setAvailLoading] = useState(false);
  const [mySlots, setMySlots] = useState<AvailabilitySlot[]>([]);
  const [openSlots, setOpenSlots] = useState<OpenBookingSlot[]>([]);
  const [myLessons, setMyLessons] = useState<Lesson[]>([]);
  const [bookingLoading, setBookingLoading] = useState(false);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [recommendedMatch, setRecommendedMatch] = useState<TeacherMatch | null>(null);
  const [rankedMatches, setRankedMatches] = useState<TeacherMatch[]>([]);
  const [matchLoading, setMatchLoading] = useState(false);
  const [timePreference, setTimePreference] = useState<StudentTimePreference>(
    emptyTimePreference
  );
  const [highlightDays, setHighlightDays] = useState<number[]>([]);
  const [highlightHours, setHighlightHours] = useState<string[]>([]);
  const [matchNotice, setMatchNotice] = useState<string | null>(null);
  const [referralAssigned, setReferralAssigned] = useState(false);
  const [teacherProfileForm, setTeacherProfileForm] = useState<TeacherProfileForm>({
    subjectsText: "",
    ageGroups: [],
    bio: "",
    profileImageUrl: "",
    bankName: "",
    bankBranch: "",
    accountNumber: "",
    accountHolderName: "",
    referralCount: 0,
    activeStudentsCount: 0,
    lastReferralAt: null,
  });
  const [profileSaving, setProfileSaving] = useState(false);
  const [teacherOnboarding, setTeacherOnboarding] = useState<TeacherOnboardingStatus | null>(
    null
  );

  // 🔥 סטייטים חדשים ומבודדים לניהול שאלון הסיווג הדינמי והאדפטיבי של התלמיד
  const [hasCompletedQuiz, setHasCompletedQuiz] = useState(false);
  const [quizStep, setQuizStep] = useState<"welcome" | "branch_select" | "school_form" | "academia_form">("welcome");
  
  // שדות הטופס הדינמי
  const [quizBranch, setQuizBranch] = useState<"school" | "academia" | null>(null);
  const [schoolSubject, setSchoolSubject] = useState("");
  const [customSubject, setCustomSubject] = useState("");
  const [schoolGrade, setSchoolGrade] = useState("");
  const [schoolLevel, setSchoolLevel] = useState("");
  const [schoolTopics, setSchoolTopics] = useState("");
  const [schoolChallenge, setSchoolChallenge] = useState("");
  const [schoolTarget, setSchoolTarget] = useState("");

  // שדות אקדמיה
  const [academyInstitution, setAcademyInstitution] = useState("");
  const [academyDegree, setAcademyDegree] = useState("");
  const [academyCourse, setAcademyCourse] = useState("");
  const [academyTarget, setAcademyTarget] = useState("");
  const [academyChallenge, setAcademyChallenge] = useState("");

  useEffect(() => {
    let cancelled = false;
    const redirected = { current: false };

    const loadUser = async () => {
      try {
        const response = await fetch("/api/me");
        if (!response.ok) {
          if (!cancelled && !redirected.current) {
            redirected.current = true;
            router.replace("/login?from=/dashboard");
          }
          return;
        }

        const data = await response.json();
        if (cancelled) return;

        setUser(data.user);
        setHasCompletedQuiz(data.hasCompletedQuiz);
        if (data.teacherOnboarding) {
          setTeacherOnboarding(data.teacherOnboarding);
        }

        if (data.user.role === "TEACHER" && data.user.isApproved) {
          fetchTeacherSlots();
          fetchTeacherProfile();
          fetchMyLessons();
        }
        if (data.user.role === "STUDENT" && data.hasCompletedQuiz) {
          fetchMyLessons();
          fetchRecommendedMatch();
        }
      } catch {
        if (!cancelled && !redirected.current) {
          redirected.current = true;
          router.replace("/login?from=/dashboard");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadUser();

    return () => {
      cancelled = true;
    };
    // Mount-only: do not depend on `router` (unstable identity can re-trigger forever)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshTeacherOnboarding = async () => {
    try {
      const response = await fetch("/api/me");
      if (!response.ok) return;
      const data = await response.json();
      if (data.teacherOnboarding) {
        setTeacherOnboarding(data.teacherOnboarding);
      }
    } catch {
      /* ignore */
    }
  };

  const fetchTeacherProfile = async () => {
    try {
      const response = await fetch("/api/admin/teacher-profile");
      if (!response.ok) return;
      const data = await response.json();
      const profile = data.profile;
      if (!profile) {
        setTeacherProfileForm({
          subjectsText: "",
          ageGroups: [],
          bio: "",
          profileImageUrl: "",
          bankName: "",
          bankBranch: "",
          accountNumber: "",
          accountHolderName: "",
          referralCount: 0,
          activeStudentsCount: 0,
          lastReferralAt: null,
        });
        return;
      }
      setTeacherProfileForm({
        subjectsText: (profile.subjects as string[]).join(", "),
        ageGroups: profile.ageGroups ?? [],
        bio: profile.bio ?? "",
        profileImageUrl: profile.profileImageUrl ?? "",
        bankName: profile.bankName ?? "",
        bankBranch: profile.bankBranch ?? "",
        accountNumber: profile.accountNumber ?? "",
        accountHolderName: profile.accountHolderName ?? "",
        referralCount: profile.referralCount ?? 0,
        activeStudentsCount: profile.activeStudentsCount ?? 0,
        lastReferralAt: profile.lastReferralAt ?? null,
      });
    } catch (err) {
      console.error(err);
    }
  };

  const fetchRecommendedMatch = async (pref?: StudentTimePreference) => {
    setMatchLoading(true);
    try {
      const active = pref ?? timePreference;
      const params = new URLSearchParams();
      if (active.requestedDays.length > 0) {
        params.set("requestedDays", active.requestedDays.join(","));
      }
      if (active.requestedTimes.length > 0) {
        params.set("requestedSlots", active.requestedTimes.join(","));
        params.set("requestedTimes", active.requestedTimes.join(","));
      }
      if (active.timeWindows.length > 0) {
        params.set(
          "timeWindows",
          active.timeWindows.map((w) => `${w.start}-${w.end}`).join(",")
        );
      }

      const qs = params.toString();
      const response = await fetch(qs ? `/api/match?${qs}` : "/api/match");
      const data = (await response.json()) as {
        error?: string;
        recommended?: TeacherMatch | null;
        matches?: TeacherMatch[];
        nearestFallback?: { message?: string } | null;
        exactAvailabilityMatches?: number;
      };
      if (!response.ok) {
        setRecommendedMatch(null);
        setRankedMatches([]);
        setMatchNotice(null);
        return;
      }
      const matches = Array.isArray(data.matches) ? data.matches : [];
      setRankedMatches(matches);
      const top = data.recommended ?? matches[0] ?? null;
      setRecommendedMatch(top);
      if (data.nearestFallback) {
        setMatchNotice(
          "אין מורה פנוי בדיוק בשעות שבחרת. הצגנו את המורים המתאימים עם המועד הפנוי הקרוב ביותר."
        );
      } else if (hasActiveTimePreference(active)) {
        setMatchNotice(
          typeof data.exactAvailabilityMatches === "number" &&
            data.exactAvailabilityMatches > 0
            ? `נמצאו ${data.exactAvailabilityMatches} מורים פנויים בשעות שבחרת`
            : null
        );
      } else {
        setMatchNotice(null);
      }
      if (top?.teacherId) {
        await loadStudentOpenSlots(top.teacherId);
      }
    } catch (err) {
      console.error(err);
      setRecommendedMatch(null);
      setRankedMatches([]);
      setMatchNotice(null);
    } finally {
      setMatchLoading(false);
    }
  };

  const applyHighlightsFromPreference = (pref: StudentTimePreference) => {
    setHighlightDays([...pref.requestedDays]);
    setHighlightHours(preferenceHighlightHours(pref));
  };

  const handleTimePreferenceChange = (next: StudentTimePreference) => {
    setTimePreference(next);
    applyHighlightsFromPreference(next);
    void fetchRecommendedMatch(next);
  };

  const clearTimePreference = () => {
    const empty = emptyTimePreference();
    setTimePreference(empty);
    setHighlightDays([]);
    setHighlightHours([]);
    setMatchNotice(null);
    void fetchRecommendedMatch(empty);
  };

  const selectMatchedTeacher = async (teacher: TeacherMatch) => {
    setRecommendedMatch(teacher);
    if (hasActiveTimePreference(timePreference)) {
      // Highlight every open cell that intersects the student's Day×Hour filter.
      setHighlightDays([...timePreference.requestedDays]);
      setHighlightHours(preferenceHighlightHours(timePreference));
    } else if (teacher.nearestSlotStart) {
      const d = new Date(teacher.nearestSlotStart);
      setHighlightDays([d.getDay()]);
      setHighlightHours([`${String(d.getHours()).padStart(2, "0")}:00`]);
    }
    await loadStudentOpenSlots(teacher.teacherId);
    toast.success(
      teacher.exactAvailabilityMatch
        ? `${teacher.teacherName} זמין בשעות דומות לבקשתך`
        : teacher.isSoftRecommendation && teacher.openSlotsCount === 0
          ? `ל${teacher.teacherName} אין כרגע שעות פנויות. כשייפתחו, הן יופיעו בלוח`
          : `הלוח מציג את השעות של ${teacher.teacherName}`
    );
  };

  const loadStudentOpenSlots = async (teacherId?: string) => {
    setSlotsLoading(true);
    try {
      const id = teacherId ?? recommendedMatch?.teacherId;
      const url = id
        ? `/api/availability?teacherId=${encodeURIComponent(id)}`
        : "/api/availability";
      const response = await fetch(url);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "שגיאה בטעינת שעות פנויות");
      setOpenSlots(data);
    } catch (err) {
      console.error(err);
    } finally {
      setSlotsLoading(false);
    }
  };

  const saveOwnTeacherProfile = async () => {
    const subjects = teacherProfileForm.subjectsText
      .split(/[,،\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (subjects.length === 0) {
      toast.error("יש להזין לפחות מקצוע התמחות אחד");
      return;
    }
    setProfileSaving(true);
    const t = toast.loading("שומר פרופיל...");
    try {
      const response = await fetch("/api/admin/teacher-profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subjects,
          ageGroups: teacherProfileForm.ageGroups,
          bio: teacherProfileForm.bio,
          profileImageUrl: teacherProfileForm.profileImageUrl,
          bankName: teacherProfileForm.bankName,
          bankBranch: teacherProfileForm.bankBranch,
          accountNumber: teacherProfileForm.accountNumber,
          accountHolderName: teacherProfileForm.accountHolderName,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "שמירה נכשלה");
      toast.success(data.message || "הפרופיל נשמר", { id: t });
      await fetchTeacherProfile();
      await refreshTeacherOnboarding();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "שגיאה בשמירה", { id: t });
    } finally {
      setProfileSaving(false);
    }
  };

  const ensureTeacherReferral = async (teacherId: string) => {
    if (referralAssigned) return;
    try {
      const response = await fetch("/api/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teacherId }),
      });
      if (response.ok) {
        setReferralAssigned(true);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const fetchTeacherSlots = async () => {
    try {
      const response = await fetch("/api/availability");
      if (response.ok) {
        const data = await response.json();
        setMySlots(data);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const fetchMyLessons = async () => {
    try {
      const response = await fetch("/api/lessons");
      if (response.ok) {
        const data = await response.json();
        setMyLessons(data);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const openBookingFlow = async () => {
    if (!user) return;
    if (user.lessonCredits < 1) {
      toast.error("כדי לקבוע שיעור צריך קודם לבחור חבילת שיעורים");
      scrollToSection("packages");
      return;
    }
    setSlotsLoading(true);
    try {
      let teacherId = recommendedMatch?.teacherId;
      if (!teacherId) {
        const matchRes = await fetch("/api/match");
        const matchData = await matchRes.json();
        if (matchRes.ok && matchData.recommended) {
          setRecommendedMatch(matchData.recommended);
          teacherId = matchData.recommended.teacherId as string;
        }
      }
      await loadStudentOpenSlots(teacherId);
      toast.success("הלוח עודכן. בחרו שעה פנויה");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "שגיאה בטעינת השעות");
    } finally {
      setSlotsLoading(false);
    }
  };

  const handleBookSlot = async (slotId: string) => {
    if (user && user.lessonCredits < 1) {
      toast.error("כדי לקבוע שיעור צריך קודם לבחור חבילת שיעורים");
      scrollToSection("packages");
      throw new Error("אין מספיק קרדיטים");
    }
    setBookingLoading(true);
    const bookingToast = toast.loading("קובעים את השיעור...");
    try {
      const slot = openSlots.find((s) => s.id === slotId);
      if (slot?.teacher?.id) {
        await ensureTeacherReferral(slot.teacher.id);
      }

      const response = await fetch("/api/lessons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slotId }),
      });
      const data = (await response.json()) as {
        error?: string;
        newCredits?: number;
      };
      if (!response.ok) throw new Error(data.error || "השיבוץ נכשל");

      setUser((prev) =>
        prev && typeof data.newCredits === "number"
          ? { ...prev, lessonCredits: data.newCredits }
          : prev
      );
      setOpenSlots((prev) => prev.filter((s) => s.id !== slotId));
      await fetchMyLessons();
      toast.success("השיעור שובץ בהצלחה!", { id: bookingToast });
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "שגיאה בשיבוץ", {
        id: bookingToast,
      });
      throw err;
    } finally {
      setBookingLoading(false);
    }
  };

  // 🔥 פונקציית שיגור נתוני השאלון האדפטיבי ל-Backend של האבחונים
  const handleSaveQuiz = async (branchType: "school" | "academia") => {
    if (!user) return;
    
    let payload = {};
    if (branchType === "school") {
      const finalSubject = schoolSubject === "אחר" ? customSubject : schoolSubject;
      if (!finalSubject || !schoolGrade || !schoolLevel || !schoolChallenge || !schoolTarget) {
        toast.error("חסרים כמה פרטים. מלאו את כל השדות כדי להמשיך");
        return;
      }
      payload = {
        ageGroup: `בית ספר - כיתה ${schoolGrade}`,
        subject: finalSubject,
        challenge: JSON.stringify({
          level: schoolLevel,
          specificTopics: schoolTopics,
          coreChallenge: schoolChallenge,
          learningTarget: schoolTarget
        })
      };
    } else {
      if (!academyInstitution || !academyDegree || !academyCourse || !academyTarget || !academyChallenge) {
        toast.error("חסרים כמה פרטים. מלאו את כל השדות כדי להמשיך");
        return;
      }
      payload = {
        ageGroup: "אקדמיה / סטודנט",
        subject: academyCourse,
        challenge: JSON.stringify({
          institution: academyInstitution,
          degreeName: academyDegree,
          learningTarget: academyTarget,
          coreChallenge: academyChallenge
        })
      };
    }

    const quizToast = toast.loading("שומרים את הפרטים...");
    try {
      const response = await fetch("/api/diagnostic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) throw new Error("השמירה לא הצליחה. נסו שוב");

      toast.success("הפרטים נשמרו. הנה המורים שמתאימים לך", { id: quizToast });
      setHasCompletedQuiz(true);
      await fetchRecommendedMatch();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "השמירה לא הצליחה. נסו שוב", { id: quizToast });
    }
  };

  // מנגנון רכישת חבילות — מפנה ל-Stripe Checkout; זיכוי קרדיטים רק אחרי Webhook
  const handlePurchase = async (packageType: "SINGLE" | "TRIO" | "MULTI" | "TEN") => {
    if (!user) return;
    setPurchaseLoading(true);
    const purchaseToast = toast.loading("מעבירים לעמוד התשלום...");

    try {
      const response = await fetch("/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageType }),
      });

      const data = (await response.json()) as {
        error?: string;
        checkoutUrl?: string;
        success?: boolean;
        isMock?: boolean;
        newCredits?: number;
        message?: string;
      };
      if (!response.ok) throw new Error(data.error || "הרכישה נכשלה");

      if (data.isMock) {
        if (typeof data.newCredits === "number") {
          setUser((prev) => (prev ? { ...prev, lessonCredits: data.newCredits! } : prev));
        }
        toast.success("קרדיטים נוספו בהצלחה במצב פיתוח", {
          id: purchaseToast,
          style: { background: "#166534", color: "#fff" },
          iconTheme: { primary: "#fff", secondary: "#166534" },
        });
        return;
      }

      if (data.checkoutUrl) {
        toast.success("מעבירים לתשלום מאובטח...", { id: purchaseToast });
        window.location.href = data.checkoutUrl;
        return;
      }

      throw new Error("לא התקבל קישור לתשלום");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "שגיאה ברכישה", { id: purchaseToast });
    } finally {
      setPurchaseLoading(false);
    }
  };

  const createSlot = async (dateTimeString: string) => {
    if (!user) return;
    setAvailLoading(true);
    const availToast = toast.loading("נועל את חלון הזמן ביומן...");

    try {
      const response = await fetch("/api/availability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startTime: dateTimeString }),
      });

      const data = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(data.error || "שגיאה בנעילת השעה");

      toast.success("חלון הזמן ננעל ונפתח לשיבוץ תלמידים! 📅", { id: availToast });
      fetchTeacherSlots();
      await refreshTeacherOnboarding();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "שגיאה בנעילת השעה", { id: availToast });
    } finally {
      setAvailLoading(false);
    }
  };

  const deleteSlot = async (slotId: string) => {
    if (!user) return;
    setAvailLoading(true);
    const availToast = toast.loading("מסיר את חלון הזמן...");
    try {
      const response = await fetch(
        `/api/availability?id=${encodeURIComponent(slotId)}`,
        { method: "DELETE" }
      );
      const data = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(data.error || "שגיאה בהסרת השעה");
      toast.success("חלון הזמן הוסר מהיומן", { id: availToast });
      fetchTeacherSlots();
      await refreshTeacherOnboarding();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "שגיאה בהסרה", { id: availToast });
    } finally {
      setAvailLoading(false);
    }
  };

  const moveSlot = async (slotId: string, dateTimeString: string) => {
    if (!user) return;
    setAvailLoading(true);
    const availToast = toast.loading("מזיז משבצת ביומן...");
    try {
      const response = await fetch("/api/availability/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slotId, startTime: dateTimeString }),
      });
      const data = (await response.json()) as {
        error?: string;
        success?: boolean;
        data?: { message?: string };
      };
      if (!response.ok) throw new Error(data.error || "שגיאה בהזזת המשבצת");
      toast.success(data.data?.message || "המשבצת הוזזה", { id: availToast });
      fetchTeacherSlots();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "שגיאה בהזזה", { id: availToast });
    } finally {
      setAvailLoading(false);
    }
  };

  const handleLogout = async () => {
    await fetch("/api/logout", { method: "POST" });
    router.replace("/login");
  };

  if (loading) {
    return (
      <div className={`${pageCanvas} flex items-center justify-center`}>
        <p className="text-sm font-medium text-neutral-500">טוען...</p>
      </div>
    );
  }
  if (!user) return null;

  const needsPackage = user.lessonCredits < 1;
  const nextLesson =
    myLessons
      .filter((l) => l.status === "SCHEDULED" || l.status === "IN_PROGRESS")
      .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime())[0] ??
    null;
  const hasBookedLesson = myLessons.some((l) => !l.status.startsWith("CANCELLED"));

  const packageTiles: {
    type: "SINGLE" | "TRIO" | "MULTI" | "TEN";
    label: string;
    title: string;
    price: string;
    popular?: boolean;
  }[] = [
    { type: "SINGLE", label: "שיעור היכרות", title: "שיעור אחד", price: "200 ₪" },
    { type: "TRIO", label: "לנושא או מבחן קרוב", title: "3 שיעורים", price: "540 ₪", popular: true },
    { type: "MULTI", label: "ליווי שוטף", title: "5 שיעורים", price: "850 ₪" },
    { type: "TEN", label: "ליווי לאורך הסמסטר", title: "10 שיעורים", price: "1,600 ₪" },
  ];

  const packagesSection = (
    <div
      id="packages"
      className={`${frostCard} p-6 space-y-4 scroll-mt-20 ${
        needsPackage ? "ring-1 ring-neutral-900/15 shadow-md" : ""
      }`}
    >
      <div className="text-start">
        <h2 className="text-base font-semibold text-neutral-900">
          {needsPackage ? "בחירת חבילת שיעורים" : "רכישת שיעורים נוספים"}
        </h2>
        <p className="text-xs text-neutral-500 mt-1">
          כל שיעור נמשך 50 דקות. התשלום מתבצע בעמוד סליקה מאובטח.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {packageTiles.map((pkg) => (
          <button
            key={pkg.type}
            disabled={purchaseLoading}
            onClick={() => handlePurchase(pkg.type)}
            className="bg-neutral-50 hover:bg-white border border-neutral-200 hover:border-neutral-400 p-5 rounded-xl text-start transition-all disabled:opacity-50 group flex flex-col justify-between h-32 relative overflow-hidden"
          >
            {pkg.popular && (
              <div className="absolute top-0 start-0 bg-neutral-900 text-[10px] font-semibold px-2 py-0.5 rounded-ee-lg text-white">
                פופולרי
              </div>
            )}
            <div>
              <div className="text-xs font-medium text-neutral-500 group-hover:text-neutral-700">
                {pkg.label}
              </div>
              <div className="text-xl font-semibold text-neutral-900 mt-1">{pkg.title}</div>
            </div>
            <div className="text-xs text-neutral-700 font-mono font-medium bg-neutral-100 border border-neutral-200 px-2 py-1 rounded-md w-fit">
              {pkg.price}
            </div>
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className={`${pageCanvas} p-6 sm:p-8 pt-12`} dir="rtl">
      <div className="max-w-6xl mx-auto space-y-8">
        
        {/* כותרת עליונה */}
        <div className={`${frostCard} p-6 flex justify-between items-center`}>
          <div>
            <span className={`${eyebrow} block mb-1`}>
              {user.role === "ADMIN" || user.role === "MANAGER"
                ? user.role === "MANAGER"
                  ? "מנהל תפעול"
                  : "מנהל מערכת"
                : user.role === "TEACHER"
                  ? "יומן העבודה שלך"
                  : "האזור האישי"}
            </span>
            <h1 className="text-2xl font-semibold text-neutral-900">שלום, {user.name}</h1>
          </div>
          <div className="flex items-center gap-3">
            {(user.role === "ADMIN" || user.role === "MANAGER") && (
              <a href="/admin" className={primaryCta}>
                לוח ניהול
              </a>
            )}
            <button onClick={handleLogout} className={secondaryCta}>
              התנתקות
            </button>
          </div>
        </div>

        {/* אדמין / מנהל */}
        {(user.role === "ADMIN" || user.role === "MANAGER") && (
          <div className={`${frostCard} p-8 text-start space-y-4`}>
            <h2 className="text-xl font-semibold text-neutral-900">
              {user.role === "MANAGER" ? "ממשק מנהל תפעול" : "ממשק מנהל מערכת"}
            </h2>
            <p className="text-sm text-neutral-600 leading-relaxed">
              כאן תוכלו לאשר מורים, לטפל בלידים ולצפות באבחונים של תלמידים.
            </p>
            <a href="/admin" className={`${primaryCta} inline-block`}>
              כניסה ללוח הניהול
            </a>
          </div>
        )}

        {/* מורה — מסלול קליטה מאחורי הקלעים */}
        {user.role === "TEACHER" && teacherOnboarding && !teacherOnboarding.isFullyActive && (
          <div className={`${frostCard} p-8 text-start space-y-5 border-amber-200/80 bg-amber-50/40`}>
            <div className="space-y-2">
              <h2 className="text-xl font-semibold text-neutral-900">
                {user.isApproved
                  ? "השלמת פרופיל המורה"
                  : "חשבון המורה ממתין לאישור צוות"}
              </h2>
              <p className="text-sm text-neutral-600 leading-relaxed">
                {user.isApproved
                  ? "החשבון אושר. השלימו את השלבים הבאים כדי להתחיל לקבל שיבוצים מתלמידים."
                  : (
                    <>
                      ההרשמה התקבלה בהצלחה. צוות <BrandWordmark /> מלווה את תהליך הקליטה — עדכונים יופיעו כאן.
                    </>
                  )}
              </p>
            </div>
            <TeacherOnboardingTimeline onboarding={teacherOnboarding} />
          </div>
        )}

        {/* ======================= חלק א': תצוגת סטודנט / הורה ======================= */}
        {user.role === "STUDENT" && (
          <div className="space-y-8">
            
            {!hasCompletedQuiz ? (
              <div className={`${frostCard} p-8 space-y-6 max-w-2xl mx-auto`}>
                
                {/* 1. מסך פתיחה ומבוא */}
                {quizStep === "welcome" && (
                  <div className="text-center space-y-6 py-4">
                    <div className="w-14 h-14 bg-neutral-100 border border-neutral-200 rounded-2xl flex items-center justify-center mx-auto text-xs font-semibold text-neutral-700">P8</div>
                    <div className="space-y-2">
                      <h2 className="text-xl font-semibold text-neutral-900">נכיר אותך רגע לפני שנמצא מורה</h2>
                      <p className="text-sm text-neutral-500 leading-relaxed max-w-md mx-auto">
                        כמה שאלות קצרות על המקצוע ועל מה שקשה לך, כדי שנציע מורים שמתאימים בדיוק לך.
                      </p>
                    </div>
                    <div className="flex justify-center pt-2">
                      <button onClick={() => setQuizStep("branch_select")} className={primaryCta}>
                        בואו נתחיל
                      </button>
                    </div>
                  </div>
                )}

                {/* 2. מסך פיצול הענפים המרכזי */}
                {quizStep === "branch_select" && (
                  <div className="space-y-4">
                    <h2 className="text-lg font-semibold text-neutral-900 text-center">איפה את/ה לומד/ת?</h2>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                      <button onClick={() => { setQuizBranch("school"); setQuizStep("school_form"); }} className="bg-neutral-50 hover:bg-white border border-neutral-200 hover:border-neutral-400 p-6 rounded-2xl text-start transition-all flex flex-col justify-between h-32">
                        <span className="text-xs font-medium text-neutral-500 tracking-wide">בית ספר</span>
                        <div>
                          <span className="block font-semibold text-sm text-neutral-900">תלמיד בית ספר / הורה</span>
                          <span className="text-[11px] text-neutral-500 block mt-0.5">יסודי, חטיבה, תיכון והכנה לבגרויות</span>
                        </div>
                      </button>

                      <button onClick={() => { setQuizBranch("academia"); setQuizStep("academia_form"); }} className="bg-neutral-50 hover:bg-white border border-neutral-200 hover:border-neutral-400 p-6 rounded-2xl text-start transition-all flex flex-col justify-between h-32">
                        <span className="text-xs font-medium text-neutral-500 tracking-wide">אקדמיה</span>
                        <div>
                          <span className="block font-semibold text-sm text-neutral-900">סטודנט באקדמיה</span>
                          <span className="text-[11px] text-neutral-500 block mt-0.5">קורסים אקדמיים באוניברסיטאות ומכללות</span>
                        </div>
                      </button>
                    </div>
                  </div>
                )}

                {/* ענף א': טופס ממוקד בית ספר */}
                {quizStep === "school_form" && (
                  <div className="space-y-5">
                    <h2 className="text-lg font-semibold text-neutral-900 border-b border-neutral-200 pb-2">כמה פרטים על הלימודים בבית הספר</h2>
                    
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-neutral-500">באיזה מקצוע הקושי? (חובה)</label>
                      <div className="grid grid-cols-3 gap-2">
                        {["מתמטיקה", "אנגלית", "פיזיקה", "כימיה/ביולוגיה", "לשון והבעה", "אחר"].map((sub) => (
                          <button key={sub} type="button" onClick={() => setSchoolSubject(sub)} className={`py-2 px-3 text-center text-xs font-medium rounded-xl border transition-all ${schoolSubject === sub ? "bg-neutral-900 border-neutral-900 text-white" : "bg-neutral-50 border-neutral-200 text-neutral-600 hover:border-neutral-400"}`}>
                            {sub}
                          </button>
                        ))}
                      </div>
                      {schoolSubject === "אחר" && (
                        <input type="text" value={customSubject} onChange={(e) => setCustomSubject(e.target.value)} placeholder="הקלידו כאן את שם המקצוע המבוקש..." className={`${fieldClass} mt-2`} />
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-neutral-500">כיתה</label>
                        <input type="text" value={schoolGrade} onChange={(e) => setSchoolGrade(e.target.value)} placeholder="למשל: י', ח', יא'" className={fieldClass} />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-neutral-500">הקבצה / רמת יחידות</label>
                        <input type="text" value={schoolLevel} onChange={(e) => setSchoolLevel(e.target.value)} placeholder="למשל: 4 יח', 5 יח', הקבצה א'" className={fieldClass} />
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-neutral-500">אילו נושאים ספציפיים צריכים חיזוק?</label>
                      <input type="text" value={schoolTopics} onChange={(e) => setSchoolTopics(e.target.value)} placeholder="למשל: גאומטריה, זמנים באנגלית, בעיות תנועה..." className={fieldClass} />
                    </div>

                    <div className="space-y-2">
                      <label className="text-xs font-medium text-neutral-500">סמנו בקליק: איפה עיקר הקושי בא לידי ביטוי?</label>
                      <div className="space-y-2">
                        {[
                          "חרדת בחינות וצורך בטכניקות מענה לחומר",
                          "חוסר בהבנת חומר בסיסי ופערי עבר משמעותיים",
                          "חוסר משמעת עצמית, סדר וארגון זמן למידה",
                          "הבנת חומר מצוינת - רצון להצטיין ולהתקדם מעבר לכיתה"
                        ].map((ch) => (
                          <button key={ch} type="button" onClick={() => setSchoolChallenge(ch)} className={`w-full text-start p-3 rounded-xl text-xs font-medium border transition-all flex justify-between items-center ${schoolChallenge === ch ? "bg-neutral-900 border-neutral-900 text-white" : "bg-neutral-50 border-neutral-200 text-neutral-600"}`}>
                            <span>{ch}</span>
                            {schoolChallenge === ch && <span className="text-emerald-300 text-xs">✓</span>}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <label className="text-xs font-medium text-neutral-500">מהו יעד הלימודים המרכזי?</label>
                      <div className="grid grid-cols-2 gap-3">
                        {[
                          { label: "מרתון ממוקד למבחן קרוב", val: "MARATHON" },
                          { label: "ליווי שוטף ארוך טווח", val: "LONG_TERM" }
                        ].map((t) => (
                          <button key={t.val} type="button" onClick={() => setSchoolTarget(t.label)} className={`p-4 rounded-xl text-center text-xs font-medium border transition-all ${schoolTarget === t.label ? "bg-neutral-900 border-neutral-900 text-white" : "bg-neutral-50 border-neutral-200 text-neutral-600"}`}>
                            {t.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <button onClick={() => handleSaveQuiz("school")} className={`${primaryCta} w-full mt-4`}>
                      שמירה והצגת מורים מתאימים
                    </button>
                  </div>
                )}

                {/* ענף ב': טופס ממוקד אקדמיה */}
                {quizStep === "academia_form" && (
                  <div className="space-y-5">
                    <h2 className="text-lg font-semibold text-neutral-900 border-b border-neutral-200 pb-2">כמה פרטים על הקורס</h2>
                    
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-neutral-500">מוסד לימודים</label>
                        <input type="text" value={academyInstitution} onChange={(e) => setAcademyInstitution(e.target.value)} placeholder="למשל: הטכניון, אוניברסיטת תל אביב" className={fieldClass} />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-neutral-500">מסלול התואר / פקולטה</label>
                        <input type="text" value={academyDegree} onChange={(e) => setAcademyDegree(e.target.value)} placeholder="למשל: מדעי המחשב, כלכלה, הנדסה" className={fieldClass} />
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-neutral-500">מהו שם הקורס המדויק שבו נדרשת עזרה?</label>
                      <input type="text" value={academyCourse} onChange={(e) => setAcademyCourse(e.target.value)} placeholder="למשל: אינפי 1, אלגברה ליניארית ת', מבני נתונים..." className={fieldClass} />
                    </div>

                    <div className="space-y-2">
                      <label className="text-xs font-medium text-neutral-500">מהו אופי הליווי המבוקש?</label>
                      <div className="grid grid-cols-2 gap-3">
                        {[
                          { label: "מרתון ממוקד למבחן (מועד א'/ב')", val: "EXAM" },
                          { label: "ליווי שוטף לאורך כל הסמסטר", val: "SEMESTER" }
                        ].map((t) => (
                          <button key={t.val} type="button" onClick={() => setAcademyTarget(t.label)} className={`p-4 rounded-xl text-center text-xs font-medium border transition-all ${academyTarget === t.label ? "bg-neutral-900 border-neutral-900 text-white" : "bg-neutral-50 border-neutral-200 text-neutral-600"}`}>
                            {t.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <label className="text-xs font-medium text-neutral-500">איפה ממוקם הקושי המרכזי בקורס?</label>
                      <div className="space-y-2">
                        {[
                          "קושי בהבנת קונספטים מופשטים ותיאורטיים של המרצה בהרצאות",
                          "חוסר הצלחה ופרקטיקה בפתרון תרגילי הבית והבנת גיליונות התרגול",
                          "לחץ זמן חריג וצורך בטכניקות מעשיות לניהול זמן בבחינה עצמה"
                        ].map((ch) => (
                          <button key={ch} type="button" onClick={() => setAcademyChallenge(ch)} className={`w-full text-start p-3 rounded-xl text-xs font-medium border transition-all flex justify-between items-center ${academyChallenge === ch ? "bg-neutral-900 border-neutral-900 text-white" : "bg-neutral-50 border-neutral-200 text-neutral-600"}`}>
                            <span>{ch}</span>
                            {academyChallenge === ch && <span className="text-emerald-300 text-xs">✓</span>}
                          </button>
                        ))}
                      </div>
                    </div>

                    <button onClick={() => handleSaveQuiz("academia")} className={`${primaryCta} w-full mt-4`}>
                      שמירה והצגת מורים מתאימים
                    </button>
                  </div>
                )}

              </div>
            ) : (
              
              /* הדאשבורד של הסטודנט נפתח במלואו רק לאחר שמירת האבחון */
              <div className="space-y-6 animate-fadeIn">
                <div className={`${frostCard} p-6 sm:p-8 flex flex-col sm:flex-row sm:items-center justify-between gap-5 text-start`}>
                  <div className="space-y-1.5">
                    <span className={`${eyebrow} block`}>
                      {nextLesson ? "השיעור הבא שלך" : "השלב הבא"}
                    </span>
                    <h2 className="text-xl sm:text-2xl font-semibold text-neutral-900 tracking-tight">
                      {nextLesson
                        ? `${new Date(nextLesson.scheduledAt).toLocaleString("he-IL", {
                            weekday: "long",
                            day: "numeric",
                            month: "long",
                            hour: "2-digit",
                            minute: "2-digit",
                            timeZone: "Asia/Jerusalem",
                          })} עם ${nextLesson.teacher.name}`
                        : needsPackage
                          ? "בחירת חבילת שיעורים"
                          : hasBookedLesson
                            ? "בחירת שעה לשיעור הבא"
                            : "בחירת שעה לשיעור ראשון"}
                    </h2>
                    <p className="text-sm text-neutral-500">
                      {nextLesson
                        ? "לדחייה או ביטול, לחצו על ⚙️ ליד השיעור בלוח השעות."
                        : needsPackage
                          ? "אחרי שתבחרו חבילה, תוכלו לקבוע שעה עם אחד המורים שמתאימים לך."
                          : "בחרו מורה מהרשימה, ואז לחצו על שעה פנויה בלוח."}
                    </p>
                  </div>
                  <div className="flex flex-col items-start sm:items-end gap-2 shrink-0">
                    <span className={badgeNeutral}>
                      {user.lessonCredits === 0
                        ? "אין עדיין שיעורים בחבילה"
                        : user.lessonCredits === 1
                          ? "שיעור אחד בחבילה"
                          : `${user.lessonCredits} שיעורים בחבילה`}
                    </span>
                    {nextLesson ? (
                      <button type="button" onClick={() => scrollToSection("schedule-board")} className={secondaryCta}>
                        ללוח השעות
                      </button>
                    ) : needsPackage ? (
                      <button type="button" onClick={() => scrollToSection("packages")} className={primaryCta}>
                        לבחירת חבילה
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={slotsLoading}
                        onClick={async () => {
                          await openBookingFlow();
                          scrollToSection("schedule-board");
                        }}
                        className={`${primaryCta} disabled:opacity-50`}
                      >
                        {slotsLoading ? "טוענים שעות..." : "לבחירת שעה"}
                      </button>
                    )}
                  </div>
                </div>

                {needsPackage && packagesSection}

                <StudentTimePreferenceBar
                  value={timePreference}
                  busy={matchLoading}
                  onChange={handleTimePreferenceChange}
                  onClear={clearTimePreference}
                />

                {matchNotice && (
                  <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-start">
                    {matchNotice}
                  </p>
                )}

                {(matchLoading || recommendedMatch || rankedMatches.length > 0) && (
                  <div className={`${frostCard} p-6 text-start space-y-4`}>
                    <div>
                      <h3 className="text-sm font-semibold text-neutral-900">
                        מורים מומלצים בהתאם למקצוע ולזמינות שלך
                      </h3>
                      <p className="text-xs text-neutral-500 mt-1">
                        לחצו על מורה כדי לראות את השעות הפנויות שלו בלוח.
                      </p>
                    </div>
                    {matchLoading && rankedMatches.length === 0 ? (
                      <p className="text-xs text-neutral-500">מחפשים מורים מתאימים...</p>
                    ) : rankedMatches.length > 0 ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {rankedMatches.slice(0, 6).map((match, index) => {
                          const isSelected = recommendedMatch?.teacherId === match.teacherId;
                          return (
                            <button
                              key={match.teacherId}
                              type="button"
                              onClick={() => selectMatchedTeacher(match)}
                              className={`w-full text-start p-4 rounded-xl border transition-all ${
                                isSelected
                                  ? "bg-neutral-900 border-neutral-900 text-white ring-1 ring-neutral-900/20"
                                  : "bg-neutral-50 border-neutral-200 hover:border-neutral-400"
                              }`}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="space-y-1 min-w-0">
                                  <div className="flex flex-wrap items-center gap-2">
                                    {index === 0 && (
                                      <span className={isSelected ? "inline-flex items-center rounded-full bg-white/15 text-white text-[10px] font-medium px-2.5 py-1" : badgeSuccess}>
                                        הכי מתאים לך
                                      </span>
                                    )}
                                    {match.exactAvailabilityMatch && (
                                      <span className={isSelected ? "inline-flex items-center rounded-full bg-emerald-400/20 text-emerald-100 text-[10px] font-medium px-2.5 py-1" : badgeSuccess}>
                                        זמין בשעות דומות לבקשתך
                                      </span>
                                    )}
                                    {match.isSoftRecommendation && match.openSlotsCount === 0 && (
                                      <span className={isSelected ? "inline-flex items-center rounded-full bg-amber-400/20 text-amber-100 text-[10px] font-medium px-2.5 py-1" : badgeWarning}>
                                        מתאים לחומר, עדיין בלי שעות פנויות
                                      </span>
                                    )}
                                    <span className={`text-sm font-semibold ${isSelected ? "text-white" : "text-neutral-900"}`}>
                                      {match.teacherName}
                                    </span>
                                  </div>
                                  <p className={`text-[11px] ${isSelected ? "text-neutral-300" : "text-neutral-500"}`}>
                                    {match.openSlotsCount > 0
                                      ? `${match.openSlotsCount} שעות פנויות`
                                      : "אין שעות פנויות כרגע"}
                                  </p>
                                  {match.nearestSlotStart && !match.exactAvailabilityMatch && (
                                    <p className={`text-[11px] ${isSelected ? "text-amber-200" : "text-amber-800"}`}>
                                      המועד הפנוי הקרוב:{" "}
                                      {new Date(match.nearestSlotStart).toLocaleString("he-IL", {
                                        weekday: "short",
                                        day: "numeric",
                                        month: "short",
                                        hour: "2-digit",
                                        minute: "2-digit",
                                      })}
                                    </p>
                                  )}
                                  {match.subjects.length > 0 && (
                                    <p className={`text-[11px] ${isSelected ? "text-neutral-300" : "text-neutral-600"}`}>
                                      {match.subjects.join(" · ")}
                                    </p>
                                  )}
                                  {studentFacingReasons(match.reasons).length > 0 && (
                                    <p className={`text-[11px] ${isSelected ? "text-neutral-400" : "text-neutral-500"}`}>
                                      {studentFacingReasons(match.reasons).slice(0, 3).join(" · ")}
                                    </p>
                                  )}
                                </div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div className={emptyState}>
                        <p className="text-sm font-medium text-neutral-900">עדיין לא מצאנו מורה פנוי</p>
                        <p className="text-xs text-neutral-500">נסו לסמן ימים או שעות נוספים, או לחזור בקרוב.</p>
                      </div>
                    )}
                  </div>
                )}

                <div id="schedule-board" className="scroll-mt-20">
                <WeeklyScheduleBoard
                  mode="student"
                  slots={openSlots}
                  lessons={myLessons}
                  userRole={user.role}
                  busy={bookingLoading || slotsLoading}
                  onBookSlot={handleBookSlot}
                  onRefresh={() => {
                    fetchMyLessons();
                    void loadStudentOpenSlots();
                  }}
                  fallbackTeachers={rankedMatches}
                  selectedTeacherId={recommendedMatch?.teacherId ?? null}
                  highlightDays={highlightDays}
                  highlightHours={highlightHours}
                  onSelectFallbackTeacher={(teacher) => {
                    const full =
                      rankedMatches.find((m) => m.teacherId === teacher.teacherId) ??
                      ({
                        teacherId: teacher.teacherId,
                        teacherName: teacher.teacherName,
                        matchScore: teacher.matchScore,
                        openSlotsCount: teacher.openSlotsCount,
                        subjects: teacher.subjects,
                        reasons: teacher.reasons,
                        isSoftRecommendation: teacher.isSoftRecommendation,
                        referralCount: 0,
                        activeStudentsCount: 0,
                        bio: null,
                        ageGroups: [],
                      } satisfies TeacherMatch);
                    void selectMatchedTeacher(full);
                  }}
                />
                </div>

                {myLessons.length > 0 && (
                  <div className={`${frostCard} p-6 space-y-3`}>
                    <h2 className="text-sm font-semibold text-neutral-900">השיעורים שלך</h2>
                    <div className="space-y-2">
                      {myLessons.map((lesson) => (
                        <LessonRow
                          key={lesson.id}
                          lesson={lesson}
                          userRole={user.role}
                          onRefresh={() => {
                            fetchMyLessons();
                            void loadStudentOpenSlots();
                          }}
                        />
                      ))}
                    </div>
                  </div>
                )}

                <div className={`${frostCard} p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-start`}>
                  <div>
                    <h3 className="text-sm font-semibold text-neutral-900">קבוצת ליווי ב-WhatsApp</h3>
                    <p className="text-xs text-neutral-500 leading-relaxed mt-1">
                      {hasBookedLesson
                        ? "בחבילות של 3 שיעורים ומעלה, קישור לקבוצת הליווי עם המורה והצוות הפדגוגי יישלח אליך ב-WhatsApp."
                        : "בחבילות של 3 שיעורים ומעלה נפתחת קבוצת ליווי עם המורה והצוות הפדגוגי, אחרי שיבוץ השיעור הראשון."}
                    </p>
                  </div>
                  {!hasBookedLesson && (
                    <span className={`${badgeNeutral} shrink-0 self-start sm:self-center`}>ייפתח לאחר שיבוץ</span>
                  )}
                </div>

                {!needsPackage && packagesSection}
              </div>
            )}
          </div>
        )}

        {/* ======================= חלק ב': תצוגת מורה ======================= */}
        {user.role === "TEACHER" && user.isApproved && (
          <div className="space-y-6">
            <div className={`${frostCard} p-6 space-y-4 text-start`}>
              <div>
                <h2 className="text-lg font-semibold text-neutral-900">פרופיל מורה</h2>
                <p className="text-xs text-neutral-500">
                  תחומי התמחות וקבוצות גיל משמשים להתאמה לפי אבחון התלמיד ולחלוקה שוויונית.
                </p>
              </div>
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="bg-neutral-50 border border-neutral-200 rounded-xl p-3">
                  <div className="text-[10px] text-neutral-500 font-medium">הפניות</div>
                  <div className="text-xl font-semibold text-neutral-900">
                    {teacherProfileForm.referralCount}
                  </div>
                </div>
                <div className="bg-neutral-50 border border-neutral-200 rounded-xl p-3">
                  <div className="text-[10px] text-neutral-500 font-medium">תלמידים פעילים</div>
                  <div className="text-xl font-semibold text-neutral-900">
                    {teacherProfileForm.activeStudentsCount}
                  </div>
                </div>
                <div className="bg-neutral-50 border border-neutral-200 rounded-xl p-3">
                  <div className="text-[10px] text-neutral-500 font-medium">הפניה אחרונה</div>
                  <div className="text-xs font-medium text-neutral-700 mt-1">
                    {teacherProfileForm.lastReferralAt
                      ? new Date(teacherProfileForm.lastReferralAt).toLocaleDateString("he-IL")
                      : "—"}
                  </div>
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-[11px] font-medium text-neutral-500">
                  תחומי התמחות (מופרדים בפסיק)
                </label>
                <input
                  type="text"
                  value={teacherProfileForm.subjectsText}
                  onChange={(e) =>
                    setTeacherProfileForm((p) => ({ ...p, subjectsText: e.target.value }))
                  }
                  placeholder="מתמטיקה, פיזיקה, אינפי 1"
                  className={fieldClass}
                />
              </div>
              <div className="space-y-2">
                <label className="text-[11px] font-medium text-neutral-500">קבוצות גיל</label>
                <div className="flex flex-wrap gap-2 justify-start">
                  {AGE_GROUP_OPTIONS.map((group) => (
                    <button
                      key={group}
                      type="button"
                      onClick={() =>
                        setTeacherProfileForm((p) => ({
                          ...p,
                          ageGroups: p.ageGroups.includes(group)
                            ? p.ageGroups.filter((g) => g !== group)
                            : [...p.ageGroups, group],
                        }))
                      }
                      className={`text-[11px] font-medium px-3 py-1.5 rounded-full border transition-all ${
                        teacherProfileForm.ageGroups.includes(group)
                          ? "bg-neutral-900 border-neutral-900 text-white"
                          : "bg-white border-neutral-200 text-neutral-600"
                      }`}
                    >
                      {group}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-[11px] font-medium text-neutral-500">אודות</label>
                <textarea
                  value={teacherProfileForm.bio}
                  onChange={(e) =>
                    setTeacherProfileForm((p) => ({ ...p, bio: e.target.value }))
                  }
                  rows={3}
                  className={`${fieldClass} resize-y`}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[11px] font-medium text-neutral-500">קישור לתמונה (אופציונלי)</label>
                <input
                  type="url"
                  dir="ltr"
                  value={teacherProfileForm.profileImageUrl}
                  onChange={(e) =>
                    setTeacherProfileForm((p) => ({ ...p, profileImageUrl: e.target.value }))
                  }
                  className={fieldClass}
                />
              </div>

              <div className="border-t border-neutral-200 pt-4 space-y-3">
                <div>
                  <h3 className="text-sm font-semibold text-neutral-900">פרטי בנק לתשלומים</h3>
                  <p className="text-[11px] text-neutral-500">
                    נדרשים לסגירת תשלומים ידנית על ידי המנהל. הפרטים נשמרים בפרופיל בלבד.
                  </p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-[11px] font-medium text-neutral-500">שם הבנק</label>
                    <input
                      type="text"
                      value={teacherProfileForm.bankName}
                      onChange={(e) =>
                        setTeacherProfileForm((p) => ({ ...p, bankName: e.target.value }))
                      }
                      placeholder="לדוגמה: לאומי"
                      className={fieldClass}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[11px] font-medium text-neutral-500">סניף</label>
                    <input
                      type="text"
                      value={teacherProfileForm.bankBranch}
                      onChange={(e) =>
                        setTeacherProfileForm((p) => ({ ...p, bankBranch: e.target.value }))
                      }
                      placeholder="מספר / שם סניף"
                      className={fieldClass}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[11px] font-medium text-neutral-500">מספר חשבון</label>
                    <input
                      type="text"
                      dir="ltr"
                      value={teacherProfileForm.accountNumber}
                      onChange={(e) =>
                        setTeacherProfileForm((p) => ({ ...p, accountNumber: e.target.value }))
                      }
                      className={fieldClass}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[11px] font-medium text-neutral-500">שם בעל החשבון</label>
                    <input
                      type="text"
                      value={teacherProfileForm.accountHolderName}
                      onChange={(e) =>
                        setTeacherProfileForm((p) => ({
                          ...p,
                          accountHolderName: e.target.value,
                        }))
                      }
                      className={fieldClass}
                    />
                  </div>
                </div>
              </div>

              <button
                type="button"
                disabled={profileSaving}
                onClick={saveOwnTeacherProfile}
                className={primaryCta}
              >
                {profileSaving ? "שומר..." : "שמור פרופיל מורה"}
              </button>
            </div>

          <WeeklyScheduleBoard
            mode="teacher"
            slots={mySlots}
            lessons={myLessons}
            userRole={user.role}
            busy={availLoading}
            onCreateSlot={createSlot}
            onDeleteSlot={deleteSlot}
            onMoveSlot={moveSlot}
            onRefresh={() => {
              fetchTeacherSlots();
              fetchMyLessons();
            }}
          />

          {myLessons.length > 0 ? (
            <div className={`${frostCard} p-6 space-y-3`}>
              <h2 className="text-sm font-semibold text-neutral-900">רשימת השיעורים המשובצים</h2>
              <div className="space-y-2">
                {myLessons.map((lesson) => (
                  <LessonRow
                    key={lesson.id}
                    lesson={lesson}
                    userRole={user.role}
                    onRefresh={() => {
                      fetchMyLessons();
                      fetchTeacherSlots();
                    }}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className={emptyState}>
              <p className="text-sm font-medium text-neutral-900">אין שיעורים משובצים עדיין</p>
              <p className="text-xs text-neutral-500">פתחו שעות פנויות ביומן כדי לקבל שיבוצים מתלמידים.</p>
            </div>
          )}
          </div>
        )}

      </div>
    </div>
  );
}
