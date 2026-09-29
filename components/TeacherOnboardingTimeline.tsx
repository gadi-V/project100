"use client";

import type { TeacherOnboardingStatus } from "../lib/teacher-onboarding";
import { badgeSuccess, badgeWarning } from "../lib/ui";

type Props = {
  onboarding: TeacherOnboardingStatus;
  compact?: boolean;
};

export default function TeacherOnboardingTimeline({ onboarding, compact = false }: Props) {
  const { steps, currentStep, isFullyActive } = onboarding;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[14px] font-medium text-neutral-500">
          מסלול קליטה · שלב {currentStep} מתוך {steps.length}
        </p>
        <span className={isFullyActive ? badgeSuccess : badgeWarning}>
          {isFullyActive ? "ACTIVE" : `STEP_${currentStep}`}
        </span>
      </div>

      <ol className={`relative ${compact ? "space-y-3" : "space-y-4"}`}>
        {steps.map((step, index) => {
          const isLast = index === steps.length - 1;
          const dotClass =
            step.status === "completed"
              ? "bg-emerald-600 border-emerald-600 text-white"
              : step.status === "current"
                ? "bg-amber-500 border-amber-400 text-white"
                : "bg-neutral-100 border-neutral-300 text-neutral-500";

          const lineClass =
            step.status === "completed"
              ? "bg-emerald-400"
              : step.status === "current"
                ? "bg-emerald-300"
                : "bg-neutral-200";

          const labelClass =
            step.status === "completed"
              ? "text-emerald-800"
              : step.status === "current"
                ? "text-neutral-900 font-semibold"
                : "text-neutral-500";

          return (
            <li key={step.id} className="relative flex gap-3 text-start">
              {!isLast && (
                <span
                  className={`absolute top-6 bottom-0 start-[11px] w-0.5 ${lineClass}`}
                  aria-hidden
                />
              )}
              <span
                className={`relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[13px] font-semibold ${dotClass}`}
              >
                {step.status === "completed" ? "✓" : step.id}
              </span>
              <div className="flex-1 pb-1 pt-0.5">
                <p className={`text-xs leading-relaxed ${labelClass}`}>{step.label}</p>
                {step.status === "current" && (
                  <p className="text-[13px] text-neutral-500 mt-0.5">בטיפול כעת</p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
