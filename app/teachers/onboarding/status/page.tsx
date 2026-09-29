"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { VettingStatus, VettingStepName, VettingStepStatus } from "@prisma/client";

interface VettingStepLog {
  id: string;
  stepNumber: number;
  stepName: VettingStepName;
  status: VettingStepStatus;
  adminNotes: string | null;
  completedAt: string | null;
}

interface TeacherProfileData {
  id: string;
  vettingStatus: VettingStatus;
  vettingNotes: string | null;
  payoutType: string;
  isApproved: boolean;
  user: {
    name: string | null;
    email: string;
  };
}

interface VettingProgressResponse {
  profile: TeacherProfileData;
  steps: VettingStepLog[];
  isComplete: boolean;
}

const STEP_METADATA: Record<
  VettingStepName,
  { title: string; desc: string; actionHint: string }
> = {
  REGISTRATION_AND_CV: {
    title: "1. Registration and CV",
    desc: "Verification of education data, CV documents, and personal details.",
    actionHint: "Your details were recorded and are under initial review.",
  },
  SCREENING_CALL: {
    title: "2. Screening call",
    desc: "A short call with the recruiting team to align availability and expectations.",
    actionHint: "A pedagogical representative will contact you to schedule.",
  },
  TEACHING_SIMULATION: {
    title: "3. Teaching simulation",
    desc: "A short sample lesson to evaluate teaching and explanation skills.",
    actionHint: "A video room invitation will be sent before the session.",
  },
  EXAM_581: {
    title: "4. Professional mastery test (581)",
    desc: "Solving in-depth math questions at the 5-unit level.",
    actionHint: "A digital test will open after the simulation.",
  },
  FINAL_VIDEO_CALL: {
    title: "5. Final interview",
    desc: "A summary call with the pedagogical manager and closing terms.",
    actionHint: "A personal meeting to finalize details.",
  },
  FINAL_APPROVAL: {
    title: "6. Teaching profile activation",
    desc: "Signing the agreement and opening the account to receive students.",
    actionHint: "When done, you will officially join the teacher team.",
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

export default function TeacherVettingStatusPage() {
  const [data, setData] = useState<VettingProgressResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const fetchStatus = async () => {
    try {
      setLoading(true);
      setErrorMsg(null);
      const res = await fetch("/api/teachers/me/vetting");
      if (!res.ok) throw new Error("Failed to load application status");
      const json = await res.json();
      setData(json);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 font-sans" dir="rtl">
        <div className="text-xs font-semibold text-slate-500">Loading application status...</div>
      </div>
    );
  }

  if (errorMsg || !data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 font-sans p-4" dir="rtl">
        <div className="max-w-md w-full rounded-2xl bg-white p-6 shadow-sm border border-slate-200 text-center space-y-4">
          <p className="text-xs font-bold text-rose-600">{errorMsg || "No application profile found"}</p>
          <Link
            href="/teachers/apply"
            className="inline-block rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-indigo-700"
          >
            Apply to teach
          </Link>
        </div>
      </div>
    );
  }

  const { profile, steps } = data;
  const logsMap = new Map(steps.map((s) => [s.stepNumber, s]));
  const passedCount = steps.filter(
    (s) => s.status === VettingStepStatus.PASSED || s.status === VettingStepStatus.SKIPPED
  ).length;

  return (
    <div className="min-h-screen bg-slate-50 py-10 px-4 font-sans text-slate-900" dir="rtl">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="rounded-2xl bg-white p-6 shadow-sm border border-slate-200 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-slate-100 pb-4">
            <div>
              <h1 className="text-xl font-bold text-slate-900">
                Hello, {profile.user.name || "candidate"}
              </h1>
              <p className="text-xs text-slate-500 mt-0.5">
                Personal tracking of your vetting and onboarding process
              </p>
            </div>
            <span
              className={`inline-flex items-center self-start sm:self-auto rounded-full px-3 py-1 text-xs font-bold ${
                profile.vettingStatus === VettingStatus.APPROVED
                  ? "bg-emerald-100 text-emerald-800 border border-emerald-300"
                  : profile.vettingStatus === VettingStatus.REJECTED
                  ? "bg-rose-100 text-rose-800 border border-rose-300"
                  : "bg-amber-100 text-amber-800 border border-amber-300"
              }`}
            >
              Status: {profile.vettingStatus}
            </span>
          </div>

          <div className="space-y-1.5">
            <div className="flex justify-between text-xs font-semibold text-slate-700">
              <span>Vetting progress</span>
              <span>
                {passedCount} of {ORDERED_STEPS.length} steps completed
              </span>
            </div>
            <div className="h-2.5 w-full rounded-full bg-slate-100 overflow-hidden border border-slate-200">
              <div
                className="h-full bg-indigo-600 transition-all duration-500"
                style={{
                  width: `${(passedCount / ORDERED_STEPS.length) * 100}%`,
                }}
              />
            </div>
          </div>

          <Link
            href="/teachers/onboarding/exam-581"
            className="block w-full rounded-xl bg-slate-900 py-2.5 text-center text-xs font-semibold text-white shadow-sm hover:bg-slate-800 transition"
          >
            פתיחת חדר מבחן 581
          </Link>
        </div>

        <div className="space-y-3">
          <h2 className="text-sm font-bold text-slate-800">Onboarding steps</h2>
          {ORDERED_STEPS.map((stepName, idx) => {
            const stepNum = idx + 1;
            const log = logsMap.get(stepNum);
            const status = log ? log.status : VettingStepStatus.PENDING;
            const meta = STEP_METADATA[stepName];

            const isPassed =
              status === VettingStepStatus.PASSED || status === VettingStepStatus.SKIPPED;
            const isFailed = status === VettingStepStatus.FAILED;
            const isPendingReview = status === VettingStepStatus.PENDING_REVIEW;

            return (
              <div
                key={stepName}
                className={`rounded-2xl border p-5 transition ${
                  isPassed
                    ? "border-emerald-200 bg-emerald-50/30"
                    : isFailed
                    ? "border-rose-200 bg-rose-50/30"
                    : isPendingReview
                    ? "border-amber-200 bg-amber-50/30"
                    : "border-slate-200 bg-white"
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-slate-900">{meta.title}</span>
                      <span
                        className={`rounded px-2 py-0.5 text-[13px] font-bold ${
                          isPassed
                            ? "bg-emerald-100 text-emerald-700"
                            : isFailed
                            ? "bg-rose-100 text-rose-700"
                            : isPendingReview
                            ? "bg-amber-100 text-amber-700"
                            : "bg-slate-100 text-slate-600"
                        }`}
                      >
                        {status}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500">{meta.desc}</p>
                    <p className="text-[14px] text-indigo-900/80 font-medium pt-1">
                      {meta.actionHint}
                    </p>
                    {log?.adminNotes && (
                      <div className="mt-2 rounded-lg bg-amber-50 p-2.5 text-xs text-amber-900 border border-amber-200">
                        <span className="font-bold">Recruiting team note: </span>
                        {log.adminNotes}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
