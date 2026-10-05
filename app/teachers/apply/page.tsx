"use client";

import React, { useState } from "react";
import Link from "next/link";
import { PayoutType } from "@prisma/client";
import { orangeCta, orangeOptionSelected } from "../../../lib/ui";

const TOPIC_OPTIONS = [
  { id: "math_581", label: "בגרות במתמטיקה 581 (5 יחידות)" },
  { id: "math_582", label: "בגרות במתמטיקה 582 (5 יחידות)" },
  { id: "math_481", label: "בגרות במתמטיקה 481 (4 יחידות)" },
  { id: "math_482", label: "בגרות במתמטיקה 482 (4 יחידות)" },
  { id: "math_381", label: "בגרות במתמטיקה 381 (3 יחידות)" },
  { id: "middle_school", label: "מתמטיקה לחטיבת ביניים" },
  { id: "linear_algebra", label: "אלגברה ליניארית (אקדמיה)" },
  { id: "calculus", label: "חשבון אינפיניטסימלי (אקדמיה)" },
];

export default function TeacherApplyPage() {
  const [cvUrl, setCvUrl] = useState("");
  const [payoutType, setPayoutType] = useState<PayoutType>(PayoutType.SLIP);
  const [selectedTopics, setSelectedTopics] = useState<string[]>([]);
  const [bio, setBio] = useState("");
  const [bankName, setBankName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");

  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);

  const toggleTopic = (id: string) => {
    setSelectedTopics((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (!cvUrl.trim()) {
      setErrorMsg("יש להוסיף קישור לקורות החיים");
      return;
    }

    if (selectedTopics.length === 0) {
      setErrorMsg("יש לבחור לפחות תחום הוראה אחד");
      return;
    }

    try {
      setLoading(true);
      const res = await fetch("/api/teachers/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cvUrl: cvUrl.trim(),
          payoutType,
          topicProficiencies: selectedTopics,
          bio: bio.trim() || undefined,
          bankName: bankName.trim() || undefined,
          accountNumber: accountNumber.trim() || undefined,
        }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || "שליחת המועמדות נכשלה");
      }

      setIsSuccess(true);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : "השליחה נכשלה");
    } finally {
      setLoading(false);
    }
  };

  if (isSuccess) {
    return (
      <div className="min-h-screen bg-slate-50 p-6 font-sans flex items-center justify-center" dir="rtl">
        <div className="max-w-md w-full rounded-2xl bg-white p-8 shadow-sm border border-slate-200 text-center space-y-4">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-2xl text-emerald-600">
            {"\u2713"}
          </div>
          <h2 className="text-xl font-bold text-slate-900">המועמדות התקבלה!</h2>
          <p className="text-xs text-slate-600 leading-relaxed">
            תודה שהגשת מועמדות. השלב הראשון בתהליך הקבלה הושלם, והצוות הפדגוגי יחזור אליך.
          </p>
          <div className="pt-2">
            <Link
              href="/teachers/onboarding/status"
              className={`inline-block w-full rounded-xl py-2.5 text-xs text-center ${orangeCta}`}
            >
              מעקב אחר סטטוס המועמדות
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 py-10 px-4 font-sans text-slate-900" dir="rtl">
      <div className="mx-auto max-w-2xl space-y-6">
        <div className="rounded-2xl bg-white p-8 shadow-sm border border-slate-200">
          <div className="border-b border-slate-100 pb-5">
            <h1 className="text-2xl font-bold text-slate-900">הצטרפות לצוות המורים</h1>
            <p className="text-xs text-slate-500 mt-1">
              ממלאים את הפרופיל ומצרפים קורות חיים כדי להתחיל את תהליך הקבלה בן 6 השלבים.
            </p>
          </div>

          {errorMsg && (
            <div className="mt-4 rounded-xl bg-rose-50 p-3.5 text-xs font-medium text-rose-700 border border-rose-200">
              {errorMsg}
            </div>
          )}

          <form onSubmit={handleSubmit} className="mt-6 space-y-6">
            <div>
              <label className="block text-xs font-bold text-slate-800 mb-1.5">
                קישור לקורות חיים (Google Drive / Dropbox / PDF) *
              </label>
              <input
                type="url"
                required
                dir="ltr"
                value={cvUrl}
                onChange={(e) => setCvUrl(e.target.value)}
                placeholder="https://drive.google.com/file/d/..."
                className="w-full rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-800 text-right outline-none focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600 transition"
              />
              <span className="text-[14px] text-slate-400 mt-1 block">
                ודאו שהקישור פתוח לצפייה לכל מי שמחזיק בו.
              </span>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-800 mb-1.5">
                תחומי הוראה ובחינות רלוונטיות *
              </label>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {TOPIC_OPTIONS.map((topic) => {
                  const isChecked = selectedTopics.includes(topic.id);
                  return (
                    <button
                      key={topic.id}
                      type="button"
                      onClick={() => toggleTopic(topic.id)}
                      className={`flex items-center gap-2 rounded-xl border p-3 text-start text-xs font-medium transition ${
                        isChecked
                          ? orangeOptionSelected
                          : "border-orange-200 bg-white text-slate-700 hover:border-orange-400"
                      }`}
                    >
                      <span
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                          isChecked
                            ? "border-orange-500 bg-orange-500 text-[13px] text-white"
                            : "border-slate-300 bg-white"
                        }`}
                      >
                        {isChecked ? "\u2713" : ""}
                      </span>
                      <span>{topic.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-800 mb-1.5">
                מודל העסקה ותשלום
              </label>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setPayoutType(PayoutType.SLIP)}
                  className={`rounded-xl border p-3 text-center text-xs font-medium transition ${
                    payoutType === PayoutType.SLIP
                      ? `${orangeOptionSelected} font-bold`
                      : "border-orange-200 bg-white text-slate-600 hover:border-orange-400"
                  }`}
                >
                  תלוש שכר (שכיר/ה)
                </button>
                <button
                  type="button"
                  onClick={() => setPayoutType(PayoutType.INVOICE)}
                  className={`rounded-xl border p-3 text-center text-xs font-medium transition ${
                    payoutType === PayoutType.INVOICE
                      ? `${orangeOptionSelected} font-bold`
                      : "border-orange-200 bg-white text-slate-600 hover:border-orange-400"
                  }`}
                >
                  חשבונית מס (עצמאי/ת)
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-bold text-slate-800 mb-1.5">
                  שם הבנק
                </label>
                <input
                  type="text"
                  value={bankName}
                  onChange={(e) => setBankName(e.target.value)}
                  placeholder="למשל: בנק לאומי"
                  className="w-full rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-800 outline-none focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600 transition"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-800 mb-1.5">
                  מספר חשבון בנק
                </label>
                <input
                  type="text"
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value)}
                  placeholder="מספר חשבון וסניף"
                  className="w-full rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-800 outline-none focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600 transition"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-800 mb-1.5">
                רקע וניסיון בהוראה (לא חובה)
              </label>
              <textarea
                rows={3}
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder="ספרו לנו בקצרה על הניסיון שלכם, שנות ההוראה וסגנון ההוראה..."
                className="w-full rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-800 outline-none focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600 transition"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className={`w-full rounded-xl py-3 text-xs ${orangeCta}`}
            >
              {loading ? "שולחים..." : "שליחת מועמדות ותחילת תהליך הקבלה"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
