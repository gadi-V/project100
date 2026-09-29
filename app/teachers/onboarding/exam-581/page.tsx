"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "react-hot-toast";
import MathFormula from "../../../../components/MathFormula";

/**
 * חדר מבחן 581 מקוון למורה מועמד.
 * ・ טיימר של שעתיים עם נעילה אוטומטית בסיום הזמן (מבוסס על חותמת התחלה, לא interval מקומי בלבד).
 * ・ מציג PDF רשמי של בגרות 581 (משרת משרד החינוך / S3 — נתיב מוגדר ב-env).
 * ・ העלאת פתרון תמונות/PDF ל-3 שאלות שנבחרו, ושמירה ב-TeacherProfile/VettingStepLog (דרך API).
 */

const EXAM_DURATION_MS = 2 * 60 * 60 * 1000; // שעתיים
const REQUIRED_QUESTIONS = 3;

const QUESTION_PROMPTS = [
  {
    id: "q1",
    title: "שאלה 1 — חשבון דיפרנציאלי",
    instruction: "פתרו את שאלת המינימום/מקסימום עם נגזרת שנייה והצדיקו.",
    formulaLatex: "f(x) = \\frac{x^2 - 4x + 3}{x - 1}",
  },
  {
    id: "q2",
    title: "שאלה 2 — אינטגרלים",
    instruction: "חשבו את האינטגרל המסוים והסבירו את שלבי החישוב.",
    formulaLatex: "\\int_0^1 x \\, e^{x} \\, dx",
  },
  {
    id: "q3",
    title: "שאלה 3 — טריגונומטריה",
    instruction: "פתרו את המשוואה הטריגונומטרית בתחום הנתון.",
    formulaLatex: "2\\sin^2 x - \\sin x - 1 = 0",
  },
];

function formatRemaining(ms: number): string {
  if (ms <= 0) return "00:00:00";
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

export default function TeacherExam581Page() {
  const examPdfUrl =
    process.env.NEXT_PUBLIC_EXAM_581_PDF_URL?.trim() ||
    "https://meyda.education.gov.il/files/Mazkirut_Pedagogit/Math/mini/mini581.pdf";

  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [remaining, setRemaining] = useState(EXAM_DURATION_MS);
  const [locked, setLocked] = useState(false);
  const [fileInputs, setFileInputs] = useState<Record<string, File | null>>({});
  const [uploading, setUploading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const canSubmit = useMemo(() => {
    const filled = Object.values(fileInputs).filter(Boolean).length;
    return filled >= REQUIRED_QUESTIONS && !locked && !submitted;
  }, [fileInputs, locked, submitted]);

  useEffect(() => {
    const stored = sessionStorage.getItem("exam581_startedAt");
    if (stored) {
      const start = Number(stored);
      setStartedAt(start);
      const elapsed = Date.now() - start;
      setRemaining(Math.max(0, EXAM_DURATION_MS - elapsed));
      if (elapsed >= EXAM_DURATION_MS) setLocked(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (startedAt === null) return;
    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const left = Math.max(0, EXAM_DURATION_MS - elapsed);
      setRemaining(left);
      if (left <= 0) {
        setLocked(true);
        if (timerRef.current) clearInterval(timerRef.current);
        toast.error("הזמן הסתיים — המבחן ננעל אוטומטית");
      }
    }, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [startedAt]);

  const handleStartExam = () => {
    const start = Date.now();
    sessionStorage.setItem("exam581_startedAt", String(start));
    setStartedAt(start);
    setRemaining(EXAM_DURATION_MS);
    setLocked(false);
  };

  const handleFileChange = (questionId: string, file: File | null) => {
    if (locked) return;
    if (file && file.size > 8 * 1024 * 1024) {
      toast.error("קובץ גדול מדי (מקס 8MB)");
      return;
    }
    setFileInputs((prev) => ({ ...prev, [questionId]: file }));
  };

  const handleSubmit = async () => {
    const filledEntries = Object.entries(fileInputs).filter(
      (e): e is [string, File] => Boolean(e[1])
    );
    if (filledEntries.length < REQUIRED_QUESTIONS) {
      toast.error("יש להעלות פתרון לשלושת השאלות");
      return;
    }
    setUploading(true);
    try {
      const formData = new FormData();
      filledEntries.forEach(([qid, file]) => formData.append("solutions", file, file.name));
      formData.append("questions", JSON.stringify(filledEntries.map(([qid]) => qid)));

      const res = await fetch("/api/teachers/me/vetting", {
        method: "POST",
        headers: { "x-user-id": "" }, // auth via session cookie server-side
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "שליחת הפתרון נכשלה");
      setSubmitted(true);
      toast.success("הפתרון נשלח לבדיקת ההנהלה — שלב 581 ממתין לאישור.");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "שגיאה בשליחת הפתרון");
    } finally {
      setUploading(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-100 p-4 sm:p-8 font-sans text-slate-900" dir="rtl">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-4 rounded-xl bg-white p-5 border border-slate-200">
          <div className="space-y-1">
            <h1 className="text-xl font-black text-slate-800">חדר מבחן 581 — מורה מועמד</h1>
            <p className="text-xs text-slate-500">
              מבחן בגרות רשמי ברמת 5 יח״ל · שעתיים · פתרון ל-3 שאלות · העלאת קובצי פתרון
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={`rounded-xl px-4 py-2 font-mono text-lg font-black tabular-nums ${
                locked
                  ? "bg-rose-100 text-rose-700 border border-rose-300"
                  : remaining <= 10 * 60 * 1000 && startedAt !== null
                    ? "bg-amber-100 text-amber-800 border border-amber-300"
                    : "bg-slate-100 text-slate-800 border border-slate-300"
              }`}
            >
              {formatRemaining(remaining)}
            </span>
            {startedAt === null && (
              <button
                type="button"
                onClick={handleStartExam}
                className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-black text-white hover:bg-emerald-700"
              >
                התחלת מבחן
              </button>
            )}
          </div>
        </header>

        {startedAt === null ? (
          <section className="rounded-xl bg-white p-8 border border-slate-200 space-y-4 text-center">
            <h2 className="text-lg font-bold text-slate-800">הוראות המבחן</h2>
            <ul className="mx-auto max-w-xl list-inside list-disc space-y-1 text-end text-sm text-slate-600">
              <li>משך המבחן: שעתיים ממועד ההתחלה — בסיום הזמן המבחן ננעל אוטומטית.</li>
              <li>יש לפתור לפחות 3 שאלות מתוך גליון הבגרות הרשמי המופיע בהמשך.</li>
              <li>העלו צילום/סריקה של הפתרון לכל שאלה (תמונה או PDF, עד 8MB כל אחד).</li>
              <li>הפתרון יועבר לבדיקת מנהל פדגוגי לפני אישור השלב.</li>
            </ul>
            <button
              type="button"
              onClick={handleStartExam}
              className="mt-2 rounded-xl bg-emerald-600 px-6 py-3 text-sm font-black text-white hover:bg-emerald-700"
            >
              התחל מבחן עכשיו
            </button>
            <div>
              <Link href="/teachers/onboarding/status" className="text-xs font-bold text-slate-500 underline">
                חזרה למצב הקליטה
              </Link>
            </div>
          </section>
        ) : (
          <>
            {/* גליון הבגרות הרשמי 581 */}
            <section className="rounded-xl bg-white p-4 border border-slate-200">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-black text-slate-800">גליון הבגרות הרשמי — שאלון 581</h2>
                <a
                  href={examPdfUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-bold text-white hover:bg-slate-700"
                >
                  פתיחה בכרטיסייה חדשה
                </a>
              </div>
              <div className="overflow-hidden rounded-xl border border-slate-300 bg-slate-50">
                <iframe
                  src={examPdfUrl}
                  title="מבחן בגרות 581 — PDF רשמי"
                  className="h-[520px] w-full"
                />
              </div>
            </section>

            {/* שלוש שאלות נבחרות + העלאת פתרון */}
            <section className="rounded-xl bg-white p-5 sm:p-6 border border-slate-200 space-y-4">
              <h2 className="text-sm font-black text-slate-800">העלאת פתרון (3 שאלות)</h2>
              {QUESTION_PROMPTS.map((q) => (
                <div key={q.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-bold text-slate-700">{q.title}</h3>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[14px] font-black ${
                        fileInputs[q.id]
                          ? "bg-emerald-100 text-emerald-700 border border-emerald-300"
                          : "bg-slate-200 text-slate-600"
                      }`}
                    >
                      {fileInputs[q.id] ? "הועלה" : "טרם הועלה"}
                    </span>
                  </div>
                  <p className="text-xs text-slate-600">{q.instruction}</p>
                  <MathFormula math={q.formulaLatex} block className="text-sm text-indigo-700" />
                  <input
                    type="file"
                    accept="image/*,.pdf"
                    disabled={locked}
                    onChange={(e) => handleFileChange(q.id, e.target.files?.[0] ?? null)}
                    className="block w-full text-xs text-slate-600 file:me-3 file:rounded-lg file:border-0 file:bg-slate-800 file:px-3 file:py-2 file:text-xs file:font-bold file:text-white hover:file:bg-slate-700"
                  />
                </div>
              ))}

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
                <div>
                  <span className="text-xs font-bold text-slate-500">שאלונים שהועלו: </span>
                  <span className="text-xs font-black text-slate-800">
                    {Object.values(fileInputs).filter(Boolean).length} / 3
                  </span>
                </div>
                <button
                  type="button"
                  disabled={!canSubmit || uploading}
                  onClick={handleSubmit}
                  className="rounded-xl bg-emerald-600 px-6 py-3 text-sm font-black text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {uploading ? "מעלה ומשגר לבדיקה..." : submitted ? "הפתרון נשלח ✓" : "שליחת פתרון לבדיקה"}
                </button>
              </div>
            </section>
          </>
        )}
      </div>
    </main>
  );
}