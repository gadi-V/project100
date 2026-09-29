"use client";

import React, { useState, use } from "react";
import { useRouter } from "next/navigation";
import { DIAGNOSTIC_MATH_BANK } from "../../../../../lib/diagnostic-bank";
import MathFormula from "../../../../../components/MathFormula";

export default function DiagnosticQuizRunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const router = useRouter();
  const resolvedParams = use(params);
  const packageId = resolvedParams.id;

  const topicKey = "math_581";
  const questions = DIAGNOSTIC_MATH_BANK[topicKey] || [];

  const [currentStep, setCurrentStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [resultData, setResultData] = useState<{
    percentage: number;
    score: number;
    totalQuestions: number;
    identifiedGaps: string[];
  } | null>(null);

  const currentQ = questions[currentStep];

  const handleSelectOption = (optionId: string) => {
    setAnswers((prev) => ({ ...prev, [currentQ.id]: optionId }));
  };

  const handleNext = () => {
    if (currentStep < questions.length - 1) {
      setCurrentStep((prev) => prev + 1);
    }
  };

  const handlePrev = () => {
    if (currentStep > 0) {
      setCurrentStep((prev) => prev - 1);
    }
  };

  const handleSubmitQuiz = async () => {
    try {
      setSubmitting(true);
      const res = await fetch("/api/diagnostic/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          packageId,
          studentId: "current-user",
          topicKey,
          answers,
        }),
      });

      if (!res.ok) throw new Error("Quiz evaluation failed");
      const json = await res.json();
      setResultData(json);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to evaluate results");
    } finally {
      setSubmitting(false);
    }
  };

  if (resultData) {
    return (
      <div className="min-h-screen bg-stone-50 py-10 px-4 font-sans text-neutral-900 flex items-center justify-center" dir="rtl">
        <div className="max-w-lg w-full rounded-2xl bg-white/80 backdrop-blur-md p-8 shadow-sm border border-neutral-200/80 text-center space-y-6">
          <div className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-neutral-100 text-neutral-900 text-2xl font-bold border border-neutral-200">
            {resultData.percentage}%
          </div>
          <div className="space-y-1">
            <h1 className="text-xl font-bold text-neutral-900">Diagnostic quiz summary</h1>
            <p className="text-xs text-neutral-500">
              You answered {resultData.score} out of {resultData.totalQuestions} questions correctly.
            </p>
          </div>

          {resultData.identifiedGaps.length > 0 && (
            <div className="rounded-2xl bg-amber-50 p-4 border border-amber-100 text-start space-y-2">
              <span className="text-xs font-bold text-amber-900">Knowledge gaps identified for the lesson:</span>
              <div className="flex flex-wrap gap-1.5">
                {resultData.identifiedGaps.map((gap, i) => (
                  <span key={i} className="rounded-full bg-white px-2.5 py-1 text-[14px] font-semibold text-amber-900 border border-amber-100">
                    {gap}
                  </span>
                ))}
              </div>
            </div>
          )}

          <button
            onClick={() => router.push(`/packages/${packageId}/report`)}
            className="w-full rounded-full bg-neutral-900 py-3 text-xs font-semibold text-white hover:bg-neutral-800 transition"
          >
            Go to the updated pedagogical report
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-stone-50 py-10 px-4 font-sans text-neutral-900" dir="rtl">
      <div className="mx-auto max-w-2xl space-y-6">
        <div className="rounded-2xl bg-white/80 backdrop-blur-md p-6 shadow-sm border border-neutral-200/80 space-y-4">
          <div className="flex items-center justify-between border-b border-neutral-100 pb-3">
            <div>
              <h1 className="text-base font-bold text-neutral-900">Quick diagnostic math quiz</h1>
              <p className="text-xs text-neutral-500">Question {currentStep + 1} of {questions.length}</p>
            </div>
            <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-bold text-amber-900 border border-amber-100">
              {currentQ?.topic}
            </span>
          </div>

          <div className="py-2 space-y-2">
            <div className="text-sm font-semibold text-neutral-800">
              {currentQ?.questionText}
            </div>
            {currentQ?.questionLatex && (
              <div className="rounded-xl bg-neutral-50 border border-neutral-200 px-3 py-2 overflow-x-auto">
                <MathFormula math={currentQ.questionLatex} block className="text-sm" />
              </div>
            )}
          </div>

          <div className="space-y-2">
            {(currentQ?.options ?? []).map((opt) => {
              const isSelected = answers[currentQ.id] === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => handleSelectOption(opt.id)}
                  className={`w-full text-start p-3 rounded-xl border text-xs font-medium transition ${
                    isSelected
                      ? "border-neutral-900 bg-neutral-900 text-white font-bold"
                      : "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50"
                  }`}
                >
                  {opt.textLatex ? (
                    <span className="inline-flex items-center gap-2">
                      <span>{opt.text}</span>
                      <MathFormula math={opt.textLatex} />
                    </span>
                  ) : (
                    opt.text
                  )}
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between pt-4 border-t border-neutral-100">
            <button
              type="button"
              onClick={handlePrev}
              disabled={currentStep === 0}
              className="rounded-full border border-neutral-200 px-4 py-2 text-xs font-semibold text-neutral-600 hover:bg-neutral-50 disabled:opacity-30"
            >
              Prev
            </button>

            {currentStep === questions.length - 1 ? (
              <button
                type="button"
                onClick={handleSubmitQuiz}
                disabled={submitting || !answers[currentQ?.id]}
                className="rounded-full bg-neutral-900 px-5 py-2 text-xs font-semibold text-white hover:bg-neutral-800 disabled:opacity-50"
              >
                {submitting ? "Evaluating..." : "Submit quiz and compute gaps"}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleNext}
                disabled={!answers[currentQ?.id]}
                className="rounded-full bg-neutral-900 px-5 py-2 text-xs font-semibold text-white hover:bg-neutral-800 disabled:opacity-30"
              >
                Next
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
