"use client";
import { useState } from "react";
import { toast } from "react-hot-toast";
import { eyebrow, fieldClass, frostCard, pageCanvas, primaryCta } from "../../lib/ui";
import { TEACHING_FRAMEWORKS, type TeachingFramework } from "../../lib/teacher-candidate";

type CandidateForm = {
  fullName: string;
  phone: string;
  email: string;
  education: string;
  yearsOfExperience: string;
  teachingFrameworks: TeachingFramework[];
  previousInstitutions: string;
  subjects: string;
  cvUrl: string;
};

type ApplyResponse = {
  success: boolean;
  error?: string;
};

const EMPTY_FORM: CandidateForm = {
  fullName: "",
  phone: "",
  email: "",
  education: "",
  yearsOfExperience: "",
  teachingFrameworks: [],
  previousInstitutions: "",
  subjects: "",
  cvUrl: "",
};

const FRAMEWORK_OPTIONS = Object.entries(TEACHING_FRAMEWORKS) as [TeachingFramework, string][];

const labelClass = "text-xs font-semibold text-neutral-600 block mb-1.5 text-start";

export default function CareersPage() {
  const [form, setForm] = useState<CandidateForm>(EMPTY_FORM);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const update = <K extends keyof CandidateForm>(key: K, value: CandidateForm[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const toggleFramework = (framework: TeachingFramework) =>
    setForm((prev) => ({
      ...prev,
      teachingFrameworks: prev.teachingFrameworks.includes(framework)
        ? prev.teachingFrameworks.filter((f) => f !== framework)
        : [...prev.teachingFrameworks, framework],
    }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.teachingFrameworks.length === 0) {
      toast.error("נא לסמן לפחות מסגרת הוראה אחת");
      return;
    }

    setLoading(true);
    try {
      const response = await fetch("/api/careers/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          yearsOfExperience: Number(form.yearsOfExperience),
        }),
      });
      const data = (await response.json()) as ApplyResponse;
      if (!response.ok || !data.success) {
        throw new Error(data.error || "שליחת המועמדות נכשלה");
      }
      setSubmitted(true);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "שליחת המועמדות נכשלה");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`${pageCanvas} py-16 px-6`} dir="rtl">
      <div className="max-w-2xl mx-auto space-y-10">
        <div className="text-start space-y-3">
          <span className={`${eyebrow} block`}>הצטרפות לנבחרת ההוראה</span>
          <h1 className="text-4xl font-semibold tracking-tight text-neutral-900">מלמדים אצלנו</h1>
          <p className="text-sm text-neutral-500 leading-relaxed max-w-xl">
            ספרו לנו על הניסיון שלכם. נעבור על כל מועמדות ונחזור אליכם לשיחת היכרות.
          </p>
        </div>

        {submitted ? (
          <div className={`${frostCard} p-8 space-y-2 text-start`}>
            <h2 className="text-xl font-semibold text-neutral-900">המועמדות התקבלה</h2>
            <p className="text-sm text-neutral-600">נחזור אליכם בטלפון או באימייל אחרי שנעבור על הפרטים.</p>
          </div>
        ) : (
          <form className={`${frostCard} p-8 space-y-6`} onSubmit={handleSubmit}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div className="sm:col-span-2">
                <label htmlFor="fullName" className={labelClass}>שם מלא</label>
                <input
                  id="fullName"
                  type="text"
                  required
                  autoComplete="name"
                  className={fieldClass}
                  value={form.fullName}
                  onChange={(e) => update("fullName", e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="phone" className={labelClass}>טלפון</label>
                <input
                  id="phone"
                  type="tel"
                  required
                  autoComplete="tel"
                  placeholder="0501234567"
                  className={fieldClass}
                  value={form.phone}
                  onChange={(e) => update("phone", e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="email" className={labelClass}>אימייל</label>
                <input
                  id="email"
                  type="email"
                  required
                  autoComplete="email"
                  dir="ltr"
                  className={fieldClass}
                  value={form.email}
                  onChange={(e) => update("email", e.target.value)}
                />
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="education" className={labelClass}>השכלה ותואר</label>
                <input
                  id="education"
                  type="text"
                  required
                  placeholder="למשל: תואר ראשון במתמטיקה, תעודת הוראה"
                  className={fieldClass}
                  value={form.education}
                  onChange={(e) => update("education", e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="yearsOfExperience" className={labelClass}>שנות ניסיון בהוראה</label>
                <input
                  id="yearsOfExperience"
                  type="number"
                  required
                  min={0}
                  max={60}
                  step={1}
                  className={fieldClass}
                  value={form.yearsOfExperience}
                  onChange={(e) => update("yearsOfExperience", e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="subjects" className={labelClass}>מקצועות התמחות</label>
                <input
                  id="subjects"
                  type="text"
                  required
                  placeholder="מתמטיקה, פיזיקה"
                  className={fieldClass}
                  value={form.subjects}
                  onChange={(e) => update("subjects", e.target.value)}
                />
              </div>
            </div>

            <fieldset className="space-y-3">
              <legend className={labelClass}>איפה לימדתם עד היום?</legend>
              <div className="flex flex-wrap gap-2">
                {FRAMEWORK_OPTIONS.map(([value, label]) => {
                  const selected = form.teachingFrameworks.includes(value);
                  return (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => toggleFramework(value)}
                      className={`rounded-full px-4 py-1.5 text-xs font-medium border transition-colors ${
                        selected
                          ? "bg-neutral-900 text-white border-neutral-900"
                          : "bg-white/60 text-neutral-700 border-neutral-300 hover:border-neutral-500"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <textarea
                id="previousInstitutions"
                rows={3}
                aria-label="פירוט מסגרות קודמות"
                placeholder="שמות בתי ספר, מכונים או פירוט על השיעורים הפרטיים"
                className={fieldClass}
                value={form.previousInstitutions}
                onChange={(e) => update("previousInstitutions", e.target.value)}
              />
            </fieldset>

            <div>
              <label htmlFor="cvUrl" className={labelClass}>קישור לקורות חיים</label>
              <input
                id="cvUrl"
                type="url"
                required
                dir="ltr"
                placeholder="https://drive.google.com/..."
                className={fieldClass}
                value={form.cvUrl}
                onChange={(e) => update("cvUrl", e.target.value)}
              />
              <p className="text-xs text-neutral-500 mt-1.5">
                קישור צפייה מ-Google Drive, Dropbox או LinkedIn.
              </p>
            </div>

            <button type="submit" disabled={loading} className={`w-full ${primaryCta}`}>
              {loading ? "שולחים..." : "שליחת מועמדות"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
