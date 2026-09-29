"use client";

import React, { useState, useEffect } from "react";

interface QuizItem {
  id: string;
  topic: string | null;
  score: number | null;
  totalQuestions: number | null;
  identifiedGaps: string[];
  createdAt: string;
}

interface DiagnosticSummaryResponse {
  packageId: string;
  totalQuizzes: number;
  averageScore: number;
  identifiedGaps: string[];
  quizzes: QuizItem[];
}

interface DiagnosticSummaryCardProps {
  packageId: string;
  currentUserId: string;
  isTeacher?: boolean;
}

export default function DiagnosticSummaryCard({
  packageId,
  currentUserId,
  isTeacher = false,
}: DiagnosticSummaryCardProps) {
  const [data, setData] = useState<DiagnosticSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [topic, setTopic] = useState("");
  const [score, setScore] = useState("");
  const [totalQuestions, setTotalQuestions] = useState("5");
  const [gapInput, setGapInput] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const fetchSummary = async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/packages/${packageId}/quiz`);
      if (!res.ok) throw new Error("Failed to load diagnostic data");
      const json = await res.json();
      setData(json);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (packageId) fetchSummary();
  }, [packageId]);

  const handleAddQuiz = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topic.trim() || !score) return;

    try {
      setSubmitting(true);
      const gaps = gapInput
        .split(",")
        .map((g) => g.trim())
        .filter(Boolean);

      const res = await fetch(`/api/packages/${packageId}/quiz`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId: currentUserId,
          topic: topic.trim(),
          score: Number(score),
          totalQuestions: Number(totalQuestions) || 5,
          identifiedGaps: gaps,
        }),
      });

      if (!res.ok) throw new Error("Failed to save quiz");

      setShowAddModal(false);
      setTopic("");
      setScore("");
      setGapInput("");
      await fetchSummary();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to save quiz");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="liquid-glass rounded-3xl p-5 font-sans"
      dir="rtl"
    >
      <div className="flex items-center justify-between border-b border-neutral-100 pb-3 mb-4">
        <div>
          <h3 className="text-sm font-bold text-neutral-900">
            Knowledge gap mapping and diagnostic quizzes
          </h3>
          <p className="text-[14px] text-neutral-500 mt-0.5">
            {isTeacher
              ? "Topics to strengthen and mastery levels identified in the student's pre-lesson quizzes"
              : "Quiz results and recommended topics to practice with your teacher"}
          </p>
        </div>

        {!isTeacher && (
          <button
            type="button"
            onClick={() => setShowAddModal(!showAddModal)}
            className="rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-xs font-semibold text-neutral-700 hover:bg-neutral-50 transition"
          >
            {showAddModal ? "Close" : "+ New quiz"}
          </button>
        )}
      </div>

      {showAddModal && (
        <form
          onSubmit={handleAddQuiz}
          className="mb-4 rounded-xl bg-neutral-50 p-3.5 border border-neutral-200/80 space-y-3"
        >
          <div className="text-xs font-bold text-neutral-800">Enter a short quiz result:</div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <input
              type="text"
              required
              placeholder="Topic (e.g. trigonometric derivative)"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              className="sm:col-span-2 rounded-xl border border-neutral-200 bg-white p-2 text-xs text-neutral-800 outline-none focus:ring-2 focus:ring-neutral-900/10 focus:border-neutral-400"
            />
            <div className="flex gap-1">
              <input
                type="number"
                required
                min="0"
                placeholder="Correct"
                value={score}
                onChange={(e) => setScore(e.target.value)}
                className="w-1/2 rounded-xl border border-neutral-200 bg-white p-2 text-xs text-neutral-800 outline-none focus:ring-2 focus:ring-neutral-900/10 focus:border-neutral-400"
              />
              <input
                type="number"
                required
                min="1"
                placeholder="Of"
                value={totalQuestions}
                onChange={(e) => setTotalQuestions(e.target.value)}
                className="w-1/2 rounded-xl border border-neutral-200 bg-white p-2 text-xs text-neutral-800 outline-none focus:ring-2 focus:ring-neutral-900/10 focus:border-neutral-400"
              />
            </div>
          </div>
          <input
            type="text"
            placeholder="Identified gaps (comma separated)"
            value={gapInput}
            onChange={(e) => setGapInput(e.target.value)}
            className="w-full rounded-xl border border-neutral-200 bg-white p-2 text-xs text-neutral-800 outline-none focus:ring-2 focus:ring-neutral-900/10 focus:border-neutral-400"
          />
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={submitting}
              className="rounded-full bg-neutral-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-neutral-800 disabled:opacity-50"
            >
              {submitting ? "Saving..." : "Save quiz"}
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="py-4 text-center text-xs text-neutral-400">Loading quiz data...</div>
      ) : !data || data.totalQuizzes === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-200 py-5 text-center text-xs text-neutral-400">
          No diagnostic quizzes yet for this package
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-xl bg-neutral-50 p-3 border border-neutral-100">
            <span className="text-xs font-medium text-neutral-700">
              Average mastery score ({data.totalQuizzes} quizzes):
            </span>
            <span
              className={`rounded-full px-3 py-0.5 text-xs font-bold ${
                data.averageScore >= 80
                  ? "bg-emerald-50 text-emerald-800"
                  : data.averageScore >= 60
                  ? "bg-amber-50 text-amber-800"
                  : "bg-red-50 text-red-800"
              }`}
            >
              {data.averageScore}%
            </span>
          </div>

          {data.identifiedGaps.length > 0 && (
            <div>
              <div className="text-[14px] font-bold text-neutral-700 mb-1.5">
                Focus areas and topics to strengthen:
              </div>
              <div className="flex flex-wrap gap-2 justify-start">
                {data.identifiedGaps.map((gap, idx) => (
                  <span
                    key={idx}
                    className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-1 text-[14px] font-medium text-amber-900 border border-amber-100"
                  >
                    {gap}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
