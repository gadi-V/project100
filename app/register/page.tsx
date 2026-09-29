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
      <div className="max-w-md mx-auto space-y-10">
        <div className="text-center space-y-2">
          <Link
            href="/"
            className="inline-flex items-center text-xs font-medium tracking-wide text-neutral-500 hover:text-neutral-900 transition-colors"
          >
            חזרה לעמוד הבית של&nbsp;<BrandWordmark />
            <BackArrow />
          </Link>
          <h1 className="text-4xl font-semibold text-neutral-900 tracking-tight pt-4">
            הרשמה ל-PROJECT100
          </h1>
          <p className="text-sm text-neutral-500">לתלמידים, לסטודנטים ולהורים.</p>
        </div>

        <Link href="/register/student" className={`${frostCard} block p-6 text-start space-y-3`}>
          <h2 className="text-xl font-semibold text-neutral-900">תלמיד/ה, סטודנט/ית או הורה</h2>
          <p className="text-sm text-neutral-500 leading-relaxed">
            פותחים חשבון, עושים אבחון קצר ומקבלים התאמה למורה.
          </p>
          <span className="inline-flex items-center text-sm font-medium text-neutral-900 pt-2">
            <ForwardArrow />
            להרשמה
          </span>
        </Link>

        <div className="text-center space-y-3">
          <p className="text-sm text-neutral-500">
            כבר יש חשבון?{" "}
            <Link href="/login" className="font-medium text-neutral-900 hover:underline">
              התחברות
            </Link>
          </p>
          <p className="text-xs text-neutral-400">
            מעוניין ללמד אצלנו?{" "}
            <Link href="/careers" className="text-neutral-600 hover:text-neutral-900 hover:underline">
              הגש מועמדות להוראה
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
