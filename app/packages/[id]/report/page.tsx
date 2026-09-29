"use client";

import React, { useEffect, useState, use } from "react";
import Link from "next/link";
import PreLessonAssetsSection from "../../../../components/packages/PreLessonAssetsSection";

interface PackageReportData {
  package: {
    id: string;
    packageName?: string;
  };
  stats: {
    totalLessons: number;
    completedLessonsCount: number;
    completionRate: number;
    activeGapsCount: number;
    quizzesCount: number;
  };
  activeGaps: string[];
  lessonsHistory: Array<{
    id: string;
    scheduledAt: string;
    pedagogicalBrief: string | null;
    teacher: {
      user: {
        name: string | null;
      };
    };
  }>;
}

export default function PackagePedagogicalReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const resolvedParams = use(params);
  const packageId = resolvedParams.id;

  const [data, setData] = useState<PackageReportData | null>(null);
  const [currentUserId, setCurrentUserId] = useState("");
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((me) => {
        if (me?.user?.id) setCurrentUserId(me.user.id);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch(`/api/packages/${packageId}/report`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load package report");
        return res.json();
      })
      .then((json) => setData(json))
      .catch((err) => setErrorMsg(err.message))
      .finally(() => setLoading(false));
  }, [packageId]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-stone-50 font-sans" dir="rtl">
        <div className="text-xs font-semibold text-neutral-500">Loading pedagogical report...</div>
      </div>
    );
  }

  if (errorMsg || !data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-stone-50 p-4 font-sans" dir="rtl">
        <div className="max-w-md w-full rounded-2xl bg-white/80 backdrop-blur-md p-6 text-center border border-neutral-200/80 shadow-sm">
          <p className="text-xs font-bold text-red-600">{errorMsg || "Package not found"}</p>
          <Link className="mt-3 inline-block text-xs text-neutral-700 underline" href="/dashboard">
            Back to dashboard
          </Link>
        </div>
      </div>
    );
  }

  const { stats, activeGaps, lessonsHistory } = data;

  return (
    <div className="min-h-screen bg-stone-50 py-10 px-4 font-sans text-neutral-900" dir="rtl">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="rounded-2xl bg-white/80 backdrop-blur-md p-6 shadow-sm border border-neutral-200/80">
          <div className="border-b border-neutral-100 pb-4 mb-4">
            <h1 className="text-xl font-bold text-neutral-900">Pedagogical overview and progress tracking</h1>
            <p className="text-xs text-neutral-500 mt-0.5">
              Track completed lessons, session summaries, and closing of math knowledge gaps.
            </p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-xl bg-neutral-50 p-3.5 border border-neutral-100">
              <div className="text-[14px] font-semibold text-neutral-500">Completed lessons</div>
              <div className="text-lg font-bold text-neutral-900 mt-1">
                {stats.completedLessonsCount} / {stats.totalLessons}
              </div>
            </div>

            <div className="rounded-xl bg-neutral-50 p-3.5 border border-neutral-100">
              <div className="text-[14px] font-semibold text-neutral-500">Progress rate</div>
              <div className="text-lg font-bold text-neutral-900 mt-1">{stats.completionRate}%</div>
            </div>

            <div className="rounded-xl bg-neutral-50 p-3.5 border border-neutral-100">
              <div className="text-[14px] font-semibold text-neutral-500">Open knowledge gaps</div>
              <div className="text-lg font-bold text-amber-700 mt-1">{stats.activeGapsCount}</div>
            </div>

            <div className="rounded-xl bg-neutral-50 p-3.5 border border-neutral-100">
              <div className="text-[14px] font-semibold text-neutral-500">Quizzes completed</div>
              <div className="text-lg font-bold text-emerald-700 mt-1">{stats.quizzesCount}</div>
            </div>
          </div>
        </div>

        {activeGaps.length > 0 && (
          <div className="rounded-2xl bg-white/80 backdrop-blur-md p-6 shadow-sm border border-neutral-200/80">
            <h2 className="text-sm font-bold text-neutral-800 mb-2">Focus areas and open knowledge gaps</h2>
            <div className="flex flex-wrap gap-2">
              {activeGaps.map((gap, idx) => (
                <span
                  key={idx}
                  className="rounded-full bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-900 border border-amber-100"
                >
                  {gap}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="rounded-2xl bg-white/80 backdrop-blur-md p-6 shadow-sm border border-neutral-200/80 space-y-4">
          <h2 className="text-sm font-bold text-neutral-800">Lesson history and pedagogical summaries</h2>
          {lessonsHistory.length === 0 ? (
            <div className="py-6 text-center text-xs text-neutral-400">
              No completed lessons yet in this package
            </div>
          ) : (
            <div className="space-y-3">
              {lessonsHistory.map((lesson) => (
                <div key={lesson.id} className="rounded-xl bg-neutral-50 p-4 border border-neutral-100 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-bold text-neutral-800">
                      Lesson with {lesson.teacher.user.name || "teacher"}
                    </span>
                    <span className="text-[14px] text-neutral-400">
                      {new Date(lesson.scheduledAt).toLocaleDateString()}
                    </span>
                  </div>
                  {lesson.pedagogicalBrief && (
                    <p className="text-xs text-neutral-700 bg-white p-3 rounded-xl border border-neutral-100 whitespace-pre-wrap">
                      {lesson.pedagogicalBrief}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {currentUserId && (
          <PreLessonAssetsSection packageId={packageId} currentUserId={currentUserId} />
        )}
      </div>
    </div>
  );
}
