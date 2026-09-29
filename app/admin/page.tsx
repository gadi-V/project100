"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "react-hot-toast";
import {
  pageCanvas,
  frostCard,
  frostPanel,
  primaryCta,
  secondaryCta,
  dangerCta,
  fieldClass,
  badgeNeutral,
  badgeSuccess,
  badgeWarning,
  emptyState,
  eyebrow,
  ledgerCard,
} from "../../lib/ui";

type Tab = "overview" | "teachers" | "leads" | "diagnostics" | "payouts" | "appeals";

type Stats = {
  studentsCount: number;
  teachersCount: number;
  pendingTeachers: number;
  openLeads: number;
  lessonsCount: number;
  paymentsCount: number;
  revenueTotal: number;
};

type TeacherProfileData = {
  subjects: string[];
  ageGroups: string[];
  bio: string | null;
  profileImageUrl: string | null;
  referralCount: number;
  activeStudentsCount: number;
  lastReferralAt: string | null;
};

type PayoutBank = {
  bankName: string | null;
  bankBranch: string | null;
  accountNumber: string | null;
  accountHolderName: string | null;
};

type PayoutQueueItem = {
  id: string;
  amount: string;
  currency: string;
  status: string;
  createdAt: string;
  lessonId: string | null;
  lesson: { id: string; title: string | null; scheduledAt: string } | null;
  teacher: {
    id: string;
    name: string;
    phone: string;
    email: string | null;
    bank: PayoutBank | null;
  };
};

type AppealItem = {
  id: string;
  title: string | null;
  scheduledAt: string;
  status: string;
  appealStatus: string;
  canceledAt: string | null;
  teacher: { id: string; name: string; phone: string };
  student: { id: string; name: string; phone: string };
};

type Teacher = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  isApproved: boolean;
  createdAt: string;
  teacherProfile: TeacherProfileData | null;
  _count: { availabilities: number; givenLessons: number };
};

type ProfileFormState = {
  subjectsText: string;
  ageGroups: string[];
  bio: string;
  profileImageUrl: string;
};

type MatchPreview = {
  teacherId: string;
  teacherName: string;
  matchScore: number;
  reasons: string[];
  referralCount: number;
};

const AGE_GROUP_OPTIONS = ["יסודי", "חטיבה", "תיכון", "אקדמיה"] as const;

type Lead = {
  id: string;
  name: string;
  phone: string;
  grade: string;
  requestedHours: string;
  isHandled: boolean;
  createdAt: string;
};

type Diagnostic = {
  id: string;
  ageGroup: string;
  subject: string;
  challenge: string;
  createdAt: string;
  student: {
    id: string;
    name: string;
    phone: string;
    email: string | null;
    lessonCredits: number;
  };
};

export default function AdminPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("overview");
  const [adminName, setAdminName] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [editingTeacherId, setEditingTeacherId] = useState<string | null>(null);
  const [profileForm, setProfileForm] = useState<ProfileFormState>({
    subjectsText: "",
    ageGroups: [],
    bio: "",
    profileImageUrl: "",
  });
  const [profileSaving, setProfileSaving] = useState(false);
  const [matchPreview, setMatchPreview] = useState<Record<string, MatchPreview | null>>({});
  const [payouts, setPayouts] = useState<PayoutQueueItem[]>([]);
  const [appeals, setAppeals] = useState<AppealItem[]>([]);

  const loadOverview = useCallback(async () => {
    const res = await fetch("/api/admin/overview");
    if (!res.ok) throw new Error("שגיאה בטעינת סקירה");
    const data = await res.json();
    setStats(data.stats);
  }, []);

  const loadTeachers = useCallback(async () => {
    const res = await fetch("/api/admin/teachers");
    if (!res.ok) throw new Error("שגיאה בטעינת מורים");
    const data = await res.json();
    setTeachers(data.teachers);
  }, []);

  const loadLeads = useCallback(async () => {
    const res = await fetch("/api/admin/leads");
    if (!res.ok) throw new Error("שגיאה בטעינת לידים");
    const data = await res.json();
    setLeads(data.leads);
  }, []);

  const loadDiagnostics = useCallback(async () => {
    const res = await fetch("/api/admin/diagnostics");
    if (!res.ok) throw new Error("שגיאה בטעינת אבחונים");
    const data = await res.json();
    setDiagnostics(data.diagnostics);
  }, []);

  const loadPayouts = useCallback(async () => {
    const res = await fetch("/api/admin/payouts");
    if (!res.ok) throw new Error("שגיאה בטעינת תשלומים");
    const data = (await res.json()) as { payouts: PayoutQueueItem[] };
    setPayouts(data.payouts);
  }, []);

  const loadAppeals = useCallback(async () => {
    const res = await fetch("/api/admin/appeals");
    if (!res.ok) throw new Error("שגיאה בטעינת ערעורים");
    const data = (await res.json()) as { appeals: AppealItem[] };
    setAppeals(data.appeals);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const redirected = { current: false };

    const boot = async () => {
      try {
        const meRes = await fetch("/api/me");
        if (!meRes.ok) {
          if (!cancelled && !redirected.current) {
            redirected.current = true;
            router.replace("/login?from=/admin");
          }
          return;
        }
        const me = await meRes.json();
        if (cancelled) return;

        if (me.user.role !== "ADMIN" && me.user.role !== "MANAGER") {
          toast.error("אין הרשאת מנהל");
          router.replace("/dashboard");
          return;
        }
        setAdminName(me.user.name);
        await Promise.all([
          loadOverview(),
          loadTeachers(),
          loadLeads(),
          loadPayouts(),
          loadAppeals(),
        ]);
      } catch {
        if (!cancelled && !redirected.current) {
          redirected.current = true;
          router.replace("/login?from=/admin");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    boot();
    return () => {
      cancelled = true;
    };
    // Mount-only: unstable `router` identity must not re-trigger this effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tab === "diagnostics" && diagnostics.length === 0) {
      loadDiagnostics().catch(() => toast.error("שגיאה בטעינת אבחונים"));
    }
    if (tab === "payouts") {
      loadPayouts().catch(() => toast.error("שגיאה בטעינת תשלומים"));
    }
    if (tab === "appeals") {
      loadAppeals().catch(() => toast.error("שגיאה בטעינת ערעורים"));
    }
  }, [tab, diagnostics.length, loadDiagnostics, loadPayouts, loadAppeals]);

  const markPayoutAsPaid = async (payoutId: string) => {
    setActionLoading(payoutId);
    const t = toast.loading("מסמן כשולם...");
    try {
      const res = await fetch("/api/admin/payouts/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payoutId }),
      });
      const data = (await res.json()) as { error?: string; transactionId?: string };
      if (!res.ok) throw new Error(data.error || "סימון נכשל");
      toast.success(
        data.transactionId ? `סומן כשולם · ${data.transactionId}` : "סומן כשולם",
        { id: t }
      );
      await loadPayouts();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "שגיאה", { id: t });
    } finally {
      setActionLoading(null);
    }
  };

  const resolveAppeal = async (lessonId: string, action: "APPROVE" | "REJECT") => {
    setActionLoading(`${action}-${lessonId}`);
    const t = toast.loading(action === "APPROVE" ? "מאשר ערעור..." : "דוחה ערעור...");
    try {
      const res = await fetch("/api/admin/appeals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lessonId, action }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || "עדכון נכשל");
      toast.success(action === "APPROVE" ? "הערעור אושר" : "הערעור נדחה", { id: t });
      await loadAppeals();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "שגיאה", { id: t });
    } finally {
      setActionLoading(null);
    }
  };

  const toggleTeacher = async (teacherId: string, isApproved: boolean) => {
    setActionLoading(teacherId);
    const t = toast.loading(isApproved ? "מאשר מורה..." : "מבטל אישור...");
    try {
      const res = await fetch("/api/admin/teachers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teacherId, isApproved }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "עדכון נכשל");
      toast.success(data.message, { id: t });
      await Promise.all([loadTeachers(), loadOverview()]);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "שגיאה", { id: t });
    } finally {
      setActionLoading(null);
    }
  };

  const toggleLead = async (leadId: string, isHandled: boolean) => {
    setActionLoading(leadId);
    const t = toast.loading(isHandled ? "מסמן כטופל..." : "פותח מחדש...");
    try {
      const res = await fetch("/api/admin/leads", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId, isHandled }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "עדכון נכשל");
      toast.success(data.message, { id: t });
      await Promise.all([loadLeads(), loadOverview()]);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "שגיאה", { id: t });
    } finally {
      setActionLoading(null);
    }
  };

  const openProfileEditor = (teacher: Teacher) => {
    const profile = teacher.teacherProfile;
    setEditingTeacherId(teacher.id);
    setProfileForm({
      subjectsText: profile?.subjects?.join(", ") ?? "",
      ageGroups: profile?.ageGroups ?? [],
      bio: profile?.bio ?? "",
      profileImageUrl: profile?.profileImageUrl ?? "",
    });
  };

  const toggleAgeGroup = (group: string) => {
    setProfileForm((prev) => ({
      ...prev,
      ageGroups: prev.ageGroups.includes(group)
        ? prev.ageGroups.filter((g) => g !== group)
        : [...prev.ageGroups, group],
    }));
  };

  const saveTeacherProfile = async (teacherId: string) => {
    const subjects = profileForm.subjectsText
      .split(/[,،\n]/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (subjects.length === 0) {
      toast.error("יש להזין לפחות מקצוע התמחות אחד");
      return;
    }

    setProfileSaving(true);
    const t = toast.loading("שומר פרופיל מורה...");
    try {
      const res = await fetch("/api/admin/teacher-profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teacherId,
          subjects,
          ageGroups: profileForm.ageGroups,
          bio: profileForm.bio,
          profileImageUrl: profileForm.profileImageUrl,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "שמירת הפרופיל נכשלה");
      toast.success(data.message || "הפרופיל נשמר", { id: t });
      setEditingTeacherId(null);
      await loadTeachers();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "שגיאה בשמירה", { id: t });
    } finally {
      setProfileSaving(false);
    }
  };

  const runMatchForStudent = async (studentId: string) => {
    setActionLoading(`match-${studentId}`);
    const t = toast.loading("מחשב התאמת מורה...");
    try {
      const res = await fetch(`/api/match?studentId=${encodeURIComponent(studentId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "ההתאמה נכשלה");
      const recommended = data.recommended as MatchPreview | null;
      setMatchPreview((prev) => ({ ...prev, [studentId]: recommended }));
      if (!recommended) {
        toast.error("לא נמצא מורה מתאים", { id: t });
      } else {
        toast.success(
          `מומלץ: ${recommended.teacherName} (ציון ${recommended.matchScore})`,
          { id: t }
        );
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "שגיאה בהתאמה", { id: t });
    } finally {
      setActionLoading(null);
    }
  };

  const assignMatchForStudent = async (studentId: string) => {
    const preview = matchPreview[studentId];
    if (!preview) {
      toast.error("יש להריץ התאמה לפני שיוך");
      return;
    }
    setActionLoading(`assign-${studentId}`);
    const t = toast.loading("משייך הפנייה למורה...");
    try {
      const res = await fetch("/api/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId, teacherId: preview.teacherId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "השיוך נכשל");
      toast.success(data.message || "הפנייה נרשמה", { id: t });
      await loadTeachers();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "שגיאה בשיוך", { id: t });
    } finally {
      setActionLoading(null);
    }
  };

  const handleLogout = async () => {
    await fetch("/api/logout", { method: "POST" });
    router.push("/login");
  };

  if (loading) {
    return (
      <div className={`${pageCanvas} flex items-center justify-center`} dir="rtl">
        <p className="text-sm text-neutral-500">טוען לוח ניהול...</p>
      </div>
    );
  }

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: "overview", label: "סקירה" },
    { id: "teachers", label: "מורים", badge: stats?.pendingTeachers },
    { id: "leads", label: "לידים", badge: stats?.openLeads },
    { id: "diagnostics", label: "אבחונים" },
    { id: "payouts", label: "תשלומי מורים", badge: payouts.length || undefined },
    { id: "appeals", label: "ערעורים", badge: appeals.length || undefined },
  ];

  return (
    <div className={`${pageCanvas} p-6 sm:p-8`} dir="rtl">
      <div className="max-w-6xl mx-auto space-y-8">
        <div className={`${frostCard} p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4`}>
          <div>
            <span className={`${eyebrow} block mb-1`}>לוח בקרה · ADMIN / MANAGER</span>
            <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
              שלום, {adminName}
            </h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/admin/lessons" className={primaryCta}>
              שיעורים · Override
            </Link>
            <Link href="/admin/curriculum" className={primaryCta}>
              תכנית לימודים
            </Link>
            <Link href="/dashboard" className={secondaryCta}>
              לדאשבורד
            </Link>
            <button type="button" onClick={handleLogout} className={secondaryCta}>
              התנתקות
            </button>
          </div>
        </div>

        <div className={`${frostPanel} p-2 flex flex-wrap gap-2`}>
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`text-xs font-medium py-2 px-4 rounded-full transition-colors flex items-center gap-2 ${
                tab === item.id
                  ? "bg-neutral-900 text-white"
                  : "text-neutral-600 hover:bg-neutral-100"
              }`}
            >
              {item.label}
              {typeof item.badge === "number" && item.badge > 0 && (
                <span className={badgeWarning}>{item.badge}</span>
              )}
            </button>
          ))}
        </div>

        {tab === "overview" && stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: "תלמידים", value: stats.studentsCount },
              { label: "מורים", value: stats.teachersCount },
              { label: "מורים ממתינים", value: stats.pendingTeachers, highlight: true },
              { label: "לידים פתוחים", value: stats.openLeads, highlight: true },
              { label: "שיעורים", value: stats.lessonsCount },
              { label: "רכישות", value: stats.paymentsCount },
              { label: "הכנסות (₪)", value: stats.revenueTotal },
            ].map((card) => (
              <div
                key={card.label}
                className={`${frostCard} p-5 ${
                  card.highlight ? "ring-1 ring-amber-200/80" : ""
                }`}
              >
                <div className="text-[14px] font-medium text-neutral-500 mb-2">{card.label}</div>
                <div className="text-3xl font-semibold tracking-tight text-neutral-900">
                  {card.value}
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === "teachers" && (
          <div className="space-y-3">
            {teachers.length === 0 ? (
              <div className={emptyState}>
                <p className="text-sm text-neutral-600">אין מורים רשומים עדיין.</p>
              </div>
            ) : (
              teachers.map((teacher) => (
                <div key={teacher.id} className={`${frostCard} p-5 space-y-4`}>
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                    <div className="text-start space-y-1 flex-1">
                      <div className="flex items-center gap-2 justify-start">
                        <h3 className="font-semibold text-neutral-900">{teacher.name}</h3>
                        <span className={teacher.isApproved ? badgeSuccess : badgeWarning}>
                          {teacher.isApproved ? "מאושר" : "ממתין"}
                        </span>
                      </div>
                      <p className="text-xs text-neutral-500" dir="ltr">
                        {teacher.phone}
                        {teacher.email ? ` · ${teacher.email}` : ""}
                      </p>
                      <p className="text-[14px] text-neutral-500">
                        {teacher._count.availabilities} שעות פתוחות · {teacher._count.givenLessons}{" "}
                        שיעורים · נרשם {new Date(teacher.createdAt).toLocaleDateString("he-IL")}
                      </p>
                      {teacher.teacherProfile ? (
                        <div className="text-[14px] text-neutral-600 space-y-0.5 pt-1">
                          <p className="text-neutral-800 font-medium">
                            מקצועות: {teacher.teacherProfile.subjects.join(" · ") || "—"}
                          </p>
                          <p>
                            קבוצות גיל:{" "}
                            {teacher.teacherProfile.ageGroups.join(" · ") || "לא הוגדר"}
                          </p>
                          <p>
                            הפניות: {teacher.teacherProfile.referralCount} · תלמידים פעילים:{" "}
                            {teacher.teacherProfile.activeStudentsCount}
                            {teacher.teacherProfile.lastReferralAt
                              ? ` · הפניה אחרונה: ${new Date(
                                  teacher.teacherProfile.lastReferralAt
                                ).toLocaleDateString("he-IL")}`
                              : " · ללא הפניות עדיין"}
                          </p>
                          {teacher.teacherProfile.bio ? (
                            <p className="text-neutral-500 line-clamp-2">
                              {teacher.teacherProfile.bio}
                            </p>
                          ) : null}
                        </div>
                      ) : (
                        <p className="text-[14px] text-amber-800">טרם הוגדר פרופיל מורה</p>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2 justify-start">
                      <button
                        type="button"
                        onClick={() =>
                          editingTeacherId === teacher.id
                            ? setEditingTeacherId(null)
                            : openProfileEditor(teacher)
                        }
                        className={secondaryCta}
                      >
                        {editingTeacherId === teacher.id ? "סגור עריכה" : "ערוך פרופיל"}
                      </button>
                      <button
                        type="button"
                        disabled={actionLoading === teacher.id}
                        onClick={() => toggleTeacher(teacher.id, !teacher.isApproved)}
                        className={
                          teacher.isApproved
                            ? secondaryCta
                            : "bg-emerald-700 text-white hover:bg-emerald-800 rounded-full px-5 py-2.5 text-sm font-medium transition-colors disabled:opacity-40"
                        }
                      >
                        {teacher.isApproved ? "בטל אישור" : "אשר מורה"}
                      </button>
                    </div>
                  </div>

                  {editingTeacherId === teacher.id && (
                    <div className="border-t border-neutral-100 pt-4 space-y-4 text-start">
                      <h4 className={`${eyebrow}`}>עריכת TeacherProfile</h4>
                      <div className="space-y-1.5">
                        <label className="text-[14px] font-medium text-neutral-500">
                          תחומי התמחות (מופרדים בפסיק)
                        </label>
                        <input
                          type="text"
                          value={profileForm.subjectsText}
                          onChange={(e) =>
                            setProfileForm((p) => ({ ...p, subjectsText: e.target.value }))
                          }
                          placeholder="מתמטיקה, פיזיקה, אינפי 1"
                          className={fieldClass}
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-[14px] font-medium text-neutral-500">
                          קבוצות גיל
                        </label>
                        <div className="flex flex-wrap gap-2 justify-start">
                          {AGE_GROUP_OPTIONS.map((group) => (
                            <button
                              key={group}
                              type="button"
                              onClick={() => toggleAgeGroup(group)}
                              className={`text-[14px] font-medium px-3 py-1.5 rounded-full border transition-colors ${
                                profileForm.ageGroups.includes(group)
                                  ? "bg-neutral-900 border-neutral-900 text-white"
                                  : "bg-white border-neutral-200 text-neutral-600 hover:bg-neutral-50"
                              }`}
                            >
                              {group}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[14px] font-medium text-neutral-500">
                          ביוגרפיה קצרה
                        </label>
                        <textarea
                          value={profileForm.bio}
                          onChange={(e) =>
                            setProfileForm((p) => ({ ...p, bio: e.target.value }))
                          }
                          rows={3}
                          className={`${fieldClass} resize-y`}
                          placeholder="ניסיון, גישה פדגוגית..."
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[14px] font-medium text-neutral-500">
                          קישור לתמונת פרופיל (אופציונלי)
                        </label>
                        <input
                          type="url"
                          dir="ltr"
                          value={profileForm.profileImageUrl}
                          onChange={(e) =>
                            setProfileForm((p) => ({ ...p, profileImageUrl: e.target.value }))
                          }
                          placeholder="https://..."
                          className={fieldClass}
                        />
                      </div>
                      <button
                        type="button"
                        disabled={profileSaving}
                        onClick={() => saveTeacherProfile(teacher.id)}
                        className={primaryCta}
                      >
                        {profileSaving ? "שומר..." : "שמור פרופיל"}
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {tab === "leads" && (
          <div className="space-y-3">
            {leads.length === 0 ? (
              <div className={emptyState}>
                <p className="text-sm text-neutral-600">אין לידים במערכת.</p>
              </div>
            ) : (
              leads.map((lead) => (
                <div
                  key={lead.id}
                  className={`${frostCard} p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4`}
                >
                  <div className="text-start space-y-1">
                    <div className="flex items-center gap-2 justify-start">
                      <h3 className="font-semibold text-neutral-900">{lead.name}</h3>
                      <span className={lead.isHandled ? badgeNeutral : badgeWarning}>
                        {lead.isHandled ? "טופל" : "פתוח"}
                      </span>
                    </div>
                    <p className="text-xs text-neutral-500" dir="ltr">
                      {lead.phone}
                    </p>
                    <p className="text-xs text-neutral-700">{lead.grade}</p>
                    <p className="text-[14px] text-neutral-500">{lead.requestedHours}</p>
                    <p className="text-[14px] text-neutral-400">
                      {new Date(lead.createdAt).toLocaleString("he-IL")}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={actionLoading === lead.id}
                    onClick={() => toggleLead(lead.id, !lead.isHandled)}
                    className={lead.isHandled ? secondaryCta : primaryCta}
                  >
                    {lead.isHandled ? "פתח מחדש" : "סמן כטופל"}
                  </button>
                </div>
              ))
            )}
          </div>
        )}

        {tab === "diagnostics" && (
          <div className="space-y-3">
            {diagnostics.length === 0 ? (
              <div className={emptyState}>
                <p className="text-sm text-neutral-600">אין אבחונים שמורים עדיין.</p>
              </div>
            ) : (
              diagnostics.map((item) => {
                let challengePreview = item.challenge;
                try {
                  const parsed = JSON.parse(item.challenge);
                  challengePreview =
                    parsed.bottleneckLabel ||
                    parsed.coreChallenge ||
                    parsed.learningTarget ||
                    item.challenge;
                } catch {
                  /* keep raw */
                }
                return (
                  <div key={item.id} className={`${frostCard} p-5 text-start space-y-2`}>
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="font-semibold text-neutral-900">{item.student.name}</h3>
                      <span className="text-[13px] font-mono text-neutral-400">
                        {new Date(item.createdAt).toLocaleDateString("he-IL")}
                      </span>
                    </div>
                    <p className="text-xs text-neutral-500" dir="ltr">
                      {item.student.phone}
                    </p>
                    <p className="text-xs text-neutral-700 font-medium">
                      {item.ageGroup} · {item.subject}
                    </p>
                    <p className="text-[14px] text-neutral-600 leading-relaxed">
                      {challengePreview}
                    </p>
                    <p className="text-[14px] text-neutral-500">
                      יתרת קרדיטים: {item.student.lessonCredits}
                    </p>
                    <div className="flex flex-wrap gap-2 justify-start pt-2">
                      <button
                        type="button"
                        disabled={actionLoading === `match-${item.student.id}`}
                        onClick={() => runMatchForStudent(item.student.id)}
                        className={primaryCta}
                      >
                        חשב התאמת מורה
                      </button>
                      {matchPreview[item.student.id] && (
                        <button
                          type="button"
                          disabled={actionLoading === `assign-${item.student.id}`}
                          onClick={() => assignMatchForStudent(item.student.id)}
                          className="bg-emerald-700 text-white hover:bg-emerald-800 rounded-full px-5 py-2.5 text-sm font-medium transition-colors disabled:opacity-40"
                        >
                          שייך הפנייה למורה המומלץ
                        </button>
                      )}
                    </div>
                    {matchPreview[item.student.id] && (
                      <div className="bg-neutral-50 border border-neutral-200 rounded-xl p-3 text-[14px] space-y-1">
                        <p className="font-medium text-neutral-900">
                          מומלץ: {matchPreview[item.student.id]!.teacherName} · ציון{" "}
                          {matchPreview[item.student.id]!.matchScore}
                        </p>
                        <p className="text-neutral-600">
                          הפניות עד כה: {matchPreview[item.student.id]!.referralCount}
                        </p>
                        {matchPreview[item.student.id]!.reasons.length > 0 && (
                          <p className="text-neutral-500">
                            {matchPreview[item.student.id]!.reasons.join(" · ")}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}

        {tab === "payouts" && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-neutral-900">תור תשלומי מורים</h2>
                <p className="text-xs text-neutral-500">
                  מורים עם יתרה לתשלום ופרטי בנק — סמן כשולם לאחר העברה ידנית.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Link href="/admin/payouts" className={primaryCta}>
                  ניהול שכר וסליקה מלא
                </Link>
                <button
                  type="button"
                  onClick={() =>
                    loadPayouts().catch(() => toast.error("שגיאה בטעינת תשלומים"))
                  }
                  className={secondaryCta}
                >
                  רענון
                </button>
              </div>
            </div>
            {payouts.length === 0 ? (
              <div className={emptyState}>
                <p className="text-sm text-neutral-600">אין תשלומים ממתינים.</p>
                <Link href="/admin/payouts" className={`inline-flex ${primaryCta}`}>
                  ניהול שכר וסליקה
                </Link>
              </div>
            ) : (
              <div className={`${frostCard} overflow-x-auto`}>
                <table className="w-full text-start text-xs min-w-[720px]">
                  <thead className="bg-neutral-50/80 text-neutral-500">
                    <tr className="border-b border-neutral-100">
                      <th className="px-5 py-4 font-medium">מורה</th>
                      <th className="px-5 py-4 font-medium">סכום</th>
                      <th className="px-5 py-4 font-medium">פרטי בנק</th>
                      <th className="px-5 py-4 font-medium">שיעור</th>
                      <th className="px-5 py-4 font-medium">סטטוס</th>
                      <th className="px-5 py-4 font-medium">פעולה</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payouts.map((p) => (
                      <tr
                        key={p.id}
                        className="border-b border-neutral-100 last:border-b-0 hover:bg-neutral-50/80 transition-colors"
                      >
                        <td className="px-5 py-4">
                          <div className="font-medium text-neutral-900">{p.teacher.name}</div>
                          <div className="text-neutral-500 font-mono text-[13px]" dir="ltr">
                            {p.teacher.phone}
                          </div>
                        </td>
                        <td className="px-5 py-4 font-semibold text-emerald-800">
                          ₪{p.amount}
                          {p.currency !== "ILS" ? ` ${p.currency}` : ""}
                        </td>
                        <td className="px-5 py-4 text-neutral-700">
                          {p.teacher.bank &&
                          (p.teacher.bank.bankName || p.teacher.bank.accountNumber) ? (
                            <div className="space-y-0.5">
                              <div>
                                {p.teacher.bank.bankName ?? "—"}
                                {p.teacher.bank.bankBranch
                                  ? ` · סניף ${p.teacher.bank.bankBranch}`
                                  : ""}
                              </div>
                              <div className="font-mono text-[13px]" dir="ltr">
                                {p.teacher.bank.accountNumber ?? "—"}
                              </div>
                              <div className="text-neutral-500">
                                {p.teacher.bank.accountHolderName ?? "—"}
                              </div>
                            </div>
                          ) : (
                            <span className={badgeWarning}>חסרים פרטי בנק</span>
                          )}
                        </td>
                        <td className="px-5 py-4 text-neutral-500">
                          {p.lesson
                            ? `${p.lesson.title ?? "שיעור"} · ${new Date(
                                p.lesson.scheduledAt
                              ).toLocaleDateString("he-IL")}`
                            : "—"}
                        </td>
                        <td className="px-5 py-4">
                          <span className={badgeWarning}>{p.status}</span>
                        </td>
                        <td className="px-5 py-4">
                          <div className={`${ledgerCard} inline-block p-2`}>
                            <button
                              type="button"
                              disabled={actionLoading === p.id}
                              onClick={() => markPayoutAsPaid(p.id)}
                              className="text-[14px] font-medium py-1.5 px-3 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50"
                            >
                              {actionLoading === p.id ? "..." : "סמן כשולם"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {tab === "appeals" && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-neutral-900">ערעורים ממתינים</h2>
                <p className="text-xs text-neutral-500">
                  Approve מזכה תלמיד ומבטל קנס מורה · Reject משאיר את הקנס בתוקף.
                </p>
              </div>
              <button
                type="button"
                onClick={() =>
                  loadAppeals().catch(() => toast.error("שגיאה בטעינת ערעורים"))
                }
                className={secondaryCta}
              >
                רענון
              </button>
            </div>
            {appeals.length === 0 ? (
              <div className={emptyState}>
                <p className="text-sm text-neutral-600">אין ערעורים ממתינים.</p>
              </div>
            ) : (
              <div className={`${frostCard} overflow-x-auto`}>
                <table className="w-full text-start text-xs min-w-[720px]">
                  <thead className="bg-neutral-50/80 text-neutral-500">
                    <tr className="border-b border-neutral-100">
                      <th className="px-5 py-4 font-medium">שיעור</th>
                      <th className="px-5 py-4 font-medium">מורה</th>
                      <th className="px-5 py-4 font-medium">תלמיד</th>
                      <th className="px-5 py-4 font-medium">מועד</th>
                      <th className="px-5 py-4 font-medium">סטטוס</th>
                      <th className="px-5 py-4 font-medium">פעולות</th>
                    </tr>
                  </thead>
                  <tbody>
                    {appeals.map((a) => (
                      <tr
                        key={a.id}
                        className="border-b border-neutral-100 last:border-b-0 hover:bg-neutral-50/80 transition-colors"
                      >
                        <td className="px-5 py-4">
                          <div className="font-medium text-neutral-900">
                            {a.title ?? "שיעור פרטי"}
                          </div>
                          <div className="text-neutral-400 font-mono text-[13px]">{a.id}</div>
                        </td>
                        <td className="px-5 py-4 text-neutral-700">{a.teacher.name}</td>
                        <td className="px-5 py-4 text-neutral-700">{a.student.name}</td>
                        <td className="px-5 py-4 text-neutral-500">
                          {new Date(a.scheduledAt).toLocaleString("he-IL")}
                        </td>
                        <td className="px-5 py-4">
                          <span className={badgeWarning}>{a.appealStatus}</span>
                        </td>
                        <td className="px-5 py-4">
                          <div className="flex flex-wrap gap-2 justify-start">
                            <button
                              type="button"
                              disabled={actionLoading !== null}
                              onClick={() => resolveAppeal(a.id, "APPROVE")}
                              className="text-[14px] font-medium py-1.5 px-3 rounded-full bg-emerald-700 hover:bg-emerald-800 text-white disabled:opacity-50"
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              disabled={actionLoading !== null}
                              onClick={() => resolveAppeal(a.id, "REJECT")}
                              className={dangerCta}
                            >
                              Reject
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
