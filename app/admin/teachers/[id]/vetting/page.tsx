"use client";

import React, { useEffect, useState, use } from "react";
import Link from "next/link";
import { VettingStepName, VettingStepStatus, VettingStatus } from "@prisma/client";
import {
  pageCanvas,
  frostCard,
  primaryCta,
  secondaryCta,
  dangerCta,
  fieldClass,
  badgeSuccess,
  badgeWarning,
  badgeDanger,
  badgeNeutral,
  emptyState,
  eyebrow,
} from "../../../../../lib/ui";

interface VettingStepLog {
  id: string;
  stepNumber: number;
  stepName: VettingStepName;
  status: VettingStepStatus;
  adminNotes: string | null;
  bypassedByAdmin: boolean;
  evaluatedByAdminId: string | null;
  completedAt: string | null;
}

interface TeacherProfileData {
  id: string;
  cvUrl: string | null;
  vettingStatus: VettingStatus;
  vettingNotes: string | null;
  payoutType: string;
  isApproved: boolean;
  bankName: string | null;
  accountNumber: string | null;
  user: {
    id: string;
    name: string | null;
    email: string;
    phone: string | null;
  };
}

interface VettingProgressResponse {
  profile: TeacherProfileData;
  steps: VettingStepLog[];
  isComplete: boolean;
}

const STEP_LABELS: Record<VettingStepName, { title: string; desc: string }> = {
  REGISTRATION_AND_CV: {
    title: "1. רישום וקורות חיים",
    desc: "בדיקת מסמכי השכלה, קורות חיים ופרטים אישיים",
  },
  SCREENING_CALL: {
    title: "2. שיחת סינון טלפונית",
    desc: "תיאום ציפיות, זמינות ורמת מחויבות",
  },
  TEACHING_SIMULATION: {
    title: "3. סימולציית הוראה",
    desc: "העברת שיעור דוגמה קצר ובחינת מתודולוגיה פדגוגית",
  },
  EXAM_581: {
    title: "4. מבחן בגרות 581",
    desc: "בדיקת שליטה מקצועית במתמטיקה ברמת 5 יח״ל",
  },
  FINAL_VIDEO_CALL: {
    title: "5. ראיון וידאו מסכם",
    desc: "ראיון אישי עם מנהל פדגוגי והתרשמות כוללת",
  },
  FINAL_APPROVAL: {
    title: "6. אישור סופי והפעלת חשבון",
    desc: "חתימה על הסכם עבודה ופתיחת פרופיל למערכת השיעורים",
  },
};

const ORDERED_STEPS: VettingStepName[] = [
  VettingStepName.REGISTRATION_AND_CV,
  VettingStepName.SCREENING_CALL,
  VettingStepName.TEACHING_SIMULATION,
  VettingStepName.EXAM_581,
  VettingStepName.FINAL_VIDEO_CALL,
  VettingStepName.FINAL_APPROVAL,
];

export default function TeacherVettingAdminPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const resolvedParams = use(params);
  const teacherId = resolvedParams.id;

  const [data, setData] = useState<VettingProgressResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatingStep, setUpdatingStep] = useState<number | null>(null);
  const [notesInput, setNotesInput] = useState<Record<number, string>>({});
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [strengthsInput, setStrengthsInput] = useState("");
  const [weaknessesInput, setWeaknessesInput] = useState("");
  const [savingPedagogy, setSavingPedagogy] = useState(false);

  const fetchData = async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/admin/teachers/${teacherId}/vetting`);
      if (!res.ok) throw new Error("Failed to fetch vetting data");
      const json: VettingProgressResponse = await res.json();
      setData(json);

      const initialNotes: Record<number, string> = {};
      json.steps.forEach((s) => {
        if (s.adminNotes) initialNotes[s.stepNumber] = s.adminNotes;
      });
      setNotesInput(initialNotes);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : "Error fetching data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [teacherId]);

  const handleUpdateStatus = async (
    stepNumber: number,
    stepName: VettingStepName,
    status: VettingStepStatus,
    bypassed = false
  ) => {
    try {
      setUpdatingStep(stepNumber);
      const res = await fetch(`/api/admin/teachers/${teacherId}/vetting`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stepNumber,
          stepName,
          status,
          adminNotes: notesInput[stepNumber] || "",
          bypassedByAdmin: bypassed,
        }),
      });

      if (!res.ok) throw new Error("Failed to update step");
      await fetchData();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to update status");
    } finally {
      setUpdatingStep(null);
    }
  };

  // Saves a structured pedagogical evaluation (strengths/weaknesses) to the
  // FINAL_APPROVAL step notes — additive, never overwrites prior notes.
  const handleSavePedagogicalAssessment = async () => {
    if (!strengthsInput.trim() && !weaknessesInput.trim()) return;
    setSavingPedagogy(true);
    try {
      const { stepNumber, stepName } =
        ORDERED_STEPS.length > 0
          ? { stepNumber: ORDERED_STEPS.length, stepName: ORDERED_STEPS[ORDERED_STEPS.length - 1] }
          : { stepNumber: 1, stepName: VettingStepName.REGISTRATION_AND_CV };

      const evaluationText = [
        strengthsInput.trim() ? `חוזקות: ${strengthsInput.trim()}` : "",
        weaknessesInput.trim() ? `חולשות: ${weaknessesInput.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      const res = await fetch(`/api/admin/teachers/${teacherId}/vetting`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stepNumber,
          stepName,
          status: VettingStepStatus.PENDING,
          adminNotes: evaluationText,
          bypassedByAdmin: false,
        }),
      });
      if (!res.ok) throw new Error("Failed to save assessment");
      await fetchData();
      alert("ההערכה הפדגוגית נשמרה");
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to save assessment");
    } finally {
      setSavingPedagogy(false);
    }
  };

  if (loading) {
    return (
      <div className={`${pageCanvas} flex items-center justify-center`} dir="rtl">
        <div className="text-sm font-medium text-neutral-500">טוען נתוני משפך סינון...</div>
      </div>
    );
  }

  if (errorMsg || !data) {
    return (
      <div className={`${pageCanvas} flex items-center justify-center p-8`} dir="rtl">
        <div className={`${emptyState} max-w-md`}>
          <p className="font-medium text-neutral-900">שגיאה בטעינת הנתונים</p>
          <p className="text-sm text-neutral-600">{errorMsg || "פרופיל המורה לא נמצא"}</p>
          <Link href="/admin/teachers" className={`inline-flex ${primaryCta}`}>
            חזרה לרשימת מורים
          </Link>
        </div>
      </div>
    );
  }

  const { profile, steps } = data;
  const logsMap = new Map(steps.map((s) => [s.stepNumber, s]));

  const funnelBadge =
    profile.vettingStatus === VettingStatus.APPROVED
      ? badgeSuccess
      : profile.vettingStatus === VettingStatus.REJECTED
        ? badgeDanger
        : badgeWarning;

  const stepStatusBadge = (status: VettingStepStatus) => {
    if (status === VettingStepStatus.PASSED) return badgeSuccess;
    if (status === VettingStepStatus.FAILED) return badgeDanger;
    if (status === VettingStepStatus.SKIPPED) return badgeNeutral;
    if (status === VettingStepStatus.PENDING) return badgeWarning;
    return badgeNeutral;
  };

  return (
    <div className={`${pageCanvas} p-8`} dir="rtl">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className={`${frostCard} p-6`}>
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-neutral-100 pb-4">
            <div>
              <p className={eyebrow}>משפך סינון</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight text-neutral-900">
                {profile.user.name || "ללא שם"}
              </h1>
              <p className="text-sm text-neutral-500">
                אימייל: {profile.user.email} | טלפון: {profile.user.phone || "לא צוין"}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-neutral-600">סטטוס משפך:</span>
              <span className={funnelBadge}>{profile.vettingStatus}</span>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3 text-sm text-neutral-600">
            <div>
              <span className="font-medium text-neutral-800">סוג תשלום: </span>
              {profile.payoutType}
            </div>
            <div>
              <span className="font-medium text-neutral-800">חשבון בנק: </span>
              {profile.bankName ? `${profile.bankName} (${profile.accountNumber})` : "לא הוזן"}
            </div>
            <div>
              <span className="font-medium text-neutral-800">קורות חיים: </span>
              {profile.cvUrl ? (
                <a
                  href={profile.cvUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-neutral-900 underline underline-offset-2 hover:text-neutral-700"
                >
                  צפה בקובץ CV
                </a>
              ) : (
                "לא הועלה קובץ"
              )}
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 border-t border-neutral-100 pt-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-700">
                חוזקות פדגוגיות
              </label>
              <textarea
                value={strengthsInput}
                onChange={(e) => setStrengthsInput(e.target.value)}
                placeholder="למשל: הסבר מסודר, סבלנות, שליטה בחומר 5 יח״ל..."
                rows={2}
                className={fieldClass}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-700">
                חולשות / נקודות לשיפור
              </label>
              <textarea
                value={weaknessesInput}
                onChange={(e) => setWeaknessesInput(e.target.value)}
                placeholder="למשל: ניהול זמן, היערכות לשיעור ראשון..."
                rows={2}
                className={fieldClass}
              />
            </div>
            <button
              type="button"
              disabled={savingPedagogy || (!strengthsInput.trim() && !weaknessesInput.trim())}
              onClick={() => handleSavePedagogicalAssessment()}
              className={`justify-self-start ${primaryCta}`}
            >
              {savingPedagogy ? "שומר..." : "שמירת הערכה פדגוגית"}
            </button>
          </div>
        </div>

        <div className={`${frostCard} p-5`}>
          <h2 className="mb-4 text-sm font-semibold text-neutral-900">דיאגרמת שלבי הקליטה</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {ORDERED_STEPS.map((stepName, idx) => {
              const stepNumber = idx + 1;
              const log = logsMap.get(stepNumber);
              const status = log ? log.status : VettingStepStatus.PENDING;
              const isSkipped =
                status === VettingStepStatus.SKIPPED || Boolean(log?.bypassedByAdmin);
              const isPassed = status === VettingStepStatus.PASSED;
              const isFailed = status === VettingStepStatus.FAILED;
              const isDone = isPassed || isSkipped;

              return (
                <div
                  key={stepName}
                  className={`rounded-2xl border p-3 text-center transition-colors ${
                    isFailed
                      ? "border-red-200 bg-red-50"
                      : isSkipped
                        ? "border-neutral-300 bg-neutral-100"
                        : isPassed
                          ? "border-emerald-200 bg-emerald-50"
                          : "border-neutral-200 bg-neutral-50"
                  }`}
                >
                  <div
                    className={`mx-auto mb-2 flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold ${
                      isFailed
                        ? "bg-red-700 text-white"
                        : isSkipped
                          ? "bg-neutral-700 text-white"
                          : isPassed
                            ? "bg-emerald-700 text-white"
                            : "bg-neutral-200 text-neutral-600"
                    }`}
                  >
                    {isFailed ? "X" : isSkipped ? "V" : isPassed ? "V" : "-"}
                  </div>
                  <p className="text-[14px] font-medium text-neutral-800">
                    {STEP_LABELS[stepName].title.replace(/^\d+\.\s*/, "")}
                  </p>
                  <p
                    className={`mt-0.5 text-[13px] font-medium ${
                      isSkipped ? "text-neutral-700" : "text-neutral-500"
                    }`}
                  >
                    {isFailed
                      ? "נדחה"
                      : isSkipped
                        ? "Skipped"
                        : isPassed
                          ? "הושלם"
                          : "ממתין"}
                  </p>
                  {isDone && log?.bypassedByAdmin && (
                    <p className="mt-0.5 text-[12px] font-medium text-neutral-500">
                      Super-Override
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-neutral-900">שלבי הסינון (6 שלבים מלאים)</h2>
          {ORDERED_STEPS.map((stepName, idx) => {
            const stepNumber = idx + 1;
            const log = logsMap.get(stepNumber);
            const status = log ? log.status : VettingStepStatus.PENDING;
            const isUpdating = updatingStep === stepNumber;
            const stepInfo = STEP_LABELS[stepName];

            return (
              <div key={stepName} className={`${frostCard} p-5`}>
                <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                  <div className="space-y-1 text-start">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="text-base font-semibold text-neutral-900">
                        {stepInfo.title}
                      </span>
                      <span className={stepStatusBadge(status)}>{status}</span>
                    </div>
                    <p className="text-xs text-neutral-500">{stepInfo.desc}</p>
                    {log?.completedAt && (
                      <p className="text-[14px] text-neutral-400">
                        הושלם בתאריך: {new Date(log.completedAt).toLocaleString("he-IL")}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={isUpdating}
                      onClick={() =>
                        handleUpdateStatus(stepNumber, stepName, VettingStepStatus.PASSED)
                      }
                      className="rounded-full bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
                    >
                      {isUpdating ? "מעדכן..." : "אשר שלב (Pass)"}
                    </button>
                    <button
                      type="button"
                      disabled={isUpdating}
                      onClick={() =>
                        handleUpdateStatus(stepNumber, stepName, VettingStepStatus.FAILED)
                      }
                      className={dangerCta}
                    >
                      פסול (Fail)
                    </button>
                    <button
                      type="button"
                      disabled={isUpdating}
                      onClick={() =>
                        handleUpdateStatus(stepNumber, stepName, VettingStepStatus.SKIPPED, true)
                      }
                      className={secondaryCta}
                    >
                      דלג מנהל (Bypass)
                    </button>

                    {stepName === VettingStepName.EXAM_581 && (
                      <button
                        type="button"
                        disabled={
                          isUpdating ||
                          status === VettingStepStatus.SKIPPED ||
                          Boolean(log?.bypassedByAdmin)
                        }
                        onClick={() =>
                          handleUpdateStatus(stepNumber, stepName, VettingStepStatus.SKIPPED, true)
                        }
                        className={primaryCta}
                        title="דילוג על מבחן 581 ע״י מנהל — מגדיר bypassedByAdmin=true"
                      >
                        {log?.bypassedByAdmin || status === VettingStepStatus.SKIPPED
                          ? "Exam Skipped"
                          : "Skip Exam Stage (Super-Override)"}
                      </button>
                    )}

                    {stepName === VettingStepName.FINAL_APPROVAL && (
                      <button
                        type="button"
                        disabled={isUpdating}
                        onClick={() =>
                          handleUpdateStatus(stepNumber, stepName, VettingStepStatus.PASSED)
                        }
                        className="rounded-full bg-emerald-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-900 disabled:opacity-50"
                        title="מאשר את המורה סופית — פותח לו דף שעות שבועי"
                      >
                        אישור סופי (Approve Teacher)
                      </button>
                    )}
                  </div>
                </div>

                <div className="mt-3 border-t border-neutral-100 pt-3">
                  <input
                    type="text"
                    placeholder="הוסף הערת מנהל לשלב זה..."
                    value={notesInput[stepNumber] || ""}
                    onChange={(e) =>
                      setNotesInput((prev) => ({ ...prev, [stepNumber]: e.target.value }))
                    }
                    className={fieldClass}
                  />
                </div>
              </div>
            );
          })}
        </div>

        <div className="pt-2">
          <Link href="/admin/teachers" className={secondaryCta}>
            חזרה לרשימת מורים
          </Link>
        </div>
      </div>
    </div>
  );
}
