import Link from "next/link";
import { pageCanvas } from "../../lib/ui";
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
    <div
      className={`${pageCanvas} relative overflow-hidden bg-gradient-to-b from-slate-50 via-white to-blue-50/60 px-5 py-14 font-sans antialiased sm:px-6 sm:py-20`}
      dir="rtl"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -top-40 mx-auto h-80 w-80 rounded-full bg-[#0070F3]/10 blur-3xl"
      />

      <div className="relative mx-auto w-full max-w-md space-y-8 sm:space-y-10">
        <header className="space-y-4 text-center">
          <Link
            href="/"
            className="inline-flex items-center text-xs font-medium tracking-wide text-slate-500 transition-colors hover:text-slate-900"
          >
            חזרה לעמוד הבית של&nbsp;<BrandWordmark />
            <BackArrow />
          </Link>
          <h1
            aria-label="הרשמה ל-PROJECT100"
            className="text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl"
          >
            הרשמה{" "}
            <span className="whitespace-nowrap">
              ל-<BrandWordmark />
            </span>
          </h1>
        </header>

        <Link
          href="/register/student"
          className="group block rounded-3xl border border-slate-200/60 bg-white/80 p-6 text-start shadow-2xl shadow-blue-900/5 backdrop-blur-xl transition-all duration-300 ease-out hover:-translate-y-0.5 hover:border-orange-300 hover:shadow-orange-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/40 sm:p-8"
        >
          <h2 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">
            הרשמת תלמידים
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-slate-500 sm:text-base">
            פותחים חשבון בכמה דקות ומתחילים ללמוד.
          </p>
          <span className="mt-6 inline-flex items-center gap-3 text-sm font-semibold text-orange-700">
            להרשמה
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-orange-500 text-white shadow-lg shadow-orange-500/25 transition-all duration-300 ease-out group-hover:-translate-x-1 group-hover:bg-orange-600">
              <ForwardArrow className="h-4 w-4" />
            </span>
          </span>
        </Link>

        <p className="text-center text-sm text-slate-500">
          כבר יש חשבון?{" "}
          <Link href="/login" className="font-medium text-slate-900 hover:underline">
            התחברות
          </Link>
        </p>
      </div>
    </div>
  );
}
