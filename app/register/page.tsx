"use client";
import Link from "next/link";
import { frostCard, pageCanvas } from "../../lib/ui";
import BrandWordmark from "../../components/BrandWordmark";

/** RTL back: arrow points right */
function BackArrow({ className = "ms-1.5 inline-block h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 12h14M13 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** RTL forward: arrow points left */
function ForwardArrow({ className = "me-1.5 inline-block h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M19 12H5M11 6l-6 6 6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function RegisterHubPage() {
  return (
    <div className={`${pageCanvas} font-sans antialiased py-16 px-6`} dir="rtl">
      <div className="max-w-xl mx-auto space-y-10">
        <div className="text-center space-y-2">
          <Link
            href="/"
            className="inline-flex items-center text-xs font-medium tracking-wide text-neutral-500 hover:text-neutral-900 transition-colors"
          >
            חזרה לעמוד הבית של&nbsp;<BrandWordmark />
            <BackArrow />
          </Link>
          <h1 className="text-4xl font-semibold text-neutral-900 tracking-tight pt-4">
            בחרו סוג הרשמה
          </h1>
          <p className="text-sm text-neutral-500">
            תהליך נפרד לתלמידים/הורים ולמורים — כדי לאסוף בדיוק את הנתונים הנכונים.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Link
            href="/register/student"
            className={`${frostCard} p-6 text-start space-y-3`}
          >
            <h2 className="text-xl font-semibold text-neutral-900">תלמיד/סטודנט</h2>
            <p className="text-sm text-neutral-500 leading-relaxed">
              אבחון לימודי, פתיחת חשבון והתאמת מורה לפי הפרופיל שלכם.
            </p>
            <span className="inline-flex items-center text-sm font-medium text-neutral-900 pt-2">
              <ForwardArrow />
              המשך להרשמת תלמיד
            </span>
          </Link>

          <Link
            href="/register/teacher"
            className={`${frostCard} p-6 text-start space-y-3`}
          >
            <h2 className="text-xl font-semibold text-neutral-900">מורה / מרצה</h2>
            <p className="text-sm text-neutral-500 leading-relaxed">
              פרופיל מקצועי, תחומי התמחות וקבוצות גיל — לאחר אישור צוות.
            </p>
            <span className="inline-flex items-center text-sm font-medium text-neutral-900 pt-2">
              <ForwardArrow />
              המשך להרשמת מורה
            </span>
          </Link>
        </div>

        <p className="text-center text-sm text-neutral-500">
          כבר יש חשבון?{" "}
          <Link href="/login" className="font-medium text-neutral-900 hover:underline">
            התחברות
          </Link>
        </p>
      </div>
    </div>
  );
}
