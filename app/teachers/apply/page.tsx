"use client";

import React, { useState } from "react";
import Link from "next/link";
import { PayoutType } from "@prisma/client";

const TOPIC_OPTIONS = [
  { id: "math_581", label: "Math exam 581 (5 units)" },
  { id: "math_582", label: "Math exam 582 (5 units)" },
  { id: "math_481", label: "Math exam 481 (4 units)" },
  { id: "math_482", label: "Math exam 482 (4 units)" },
  { id: "math_381", label: "Math exam 381 (3 units)" },
  { id: "middle_school", label: "Middle school math" },
  { id: "linear_algebra", label: "Linear algebra (academic)" },
  { id: "calculus", label: "Calculus / Infinitesimal (academic)" },
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
      setErrorMsg("Please provide a CV link");
      return;
    }

    if (selectedTopics.length === 0) {
      setErrorMsg("Please select at least one teaching area");
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
        throw new Error(errJson.error || "Failed to submit application");
      }

      setIsSuccess(true);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : "Submission failed");
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
          <h2 className="text-xl font-bold text-slate-900">Application received!</h2>
          <p className="text-xs text-slate-600 leading-relaxed">
            Thank you for applying. Step 1 of the vetting funnel is complete and the pedagogical team will contact you.
          </p>
          <div className="pt-2">
            <Link
              href="/teachers/onboarding/status"
              className="inline-block w-full rounded-xl bg-slate-900 py-2.5 text-xs font-semibold text-white shadow-sm hover:bg-slate-800 transition text-center"
            >
              Track application status
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
            <h1 className="text-2xl font-bold text-slate-900">Join the teacher team</h1>
            <p className="text-xs text-slate-500 mt-1">
              Complete your profile and submit your CV to start the 6-step vetting process.
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
                CV link (Google Drive / Dropbox / PDF) *
              </label>
              <input
                type="url"
                required
                value={cvUrl}
                onChange={(e) => setCvUrl(e.target.value)}
                placeholder="https://drive.google.com/file/d/..."
                className="w-full rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-800 outline-none focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600 transition"
              />
              <span className="text-[14px] text-slate-400 mt-1 block">
                Make sure the link is public for anyone with the link.
              </span>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-800 mb-1.5">
                Teaching areas and relevant exams *
              </label>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {TOPIC_OPTIONS.map((topic) => {
                  const isChecked = selectedTopics.includes(topic.id);
                  return (
                    <button
                      key={topic.id}
                      type="button"
                      onClick={() => toggleTopic(topic.id)}
                      className={`flex items-center gap-2 rounded-xl border p-3 text-end text-xs font-medium transition ${
                        isChecked
                          ? "border-indigo-600 bg-indigo-50/60 text-indigo-900"
                          : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                      }`}
                    >
                      <span
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                          isChecked
                            ? "border-indigo-600 bg-indigo-600 text-[13px] text-white"
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
                Employment and payout model
              </label>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setPayoutType(PayoutType.SLIP)}
                  className={`rounded-xl border p-3 text-center text-xs font-medium transition ${
                    payoutType === PayoutType.SLIP
                      ? "border-indigo-600 bg-indigo-50/60 text-indigo-900 font-bold"
                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  Pay slip (employee)
                </button>
                <button
                  type="button"
                  onClick={() => setPayoutType(PayoutType.INVOICE)}
                  className={`rounded-xl border p-3 text-center text-xs font-medium transition ${
                    payoutType === PayoutType.INVOICE
                      ? "border-indigo-600 bg-indigo-50/60 text-indigo-900 font-bold"
                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  Tax invoice (freelancer)
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-bold text-slate-800 mb-1.5">
                  Bank name
                </label>
                <input
                  type="text"
                  value={bankName}
                  onChange={(e) => setBankName(e.target.value)}
                  placeholder="e.g. Bank Leumi"
                  className="w-full rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-800 outline-none focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600 transition"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-800 mb-1.5">
                  Bank account number
                </label>
                <input
                  type="text"
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value)}
                  placeholder="Account and branch"
                  className="w-full rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-800 outline-none focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600 transition"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-800 mb-1.5">
                Teaching background and experience (optional)
              </label>
              <textarea
                rows={3}
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder="Tell us briefly about your experience, years of teaching, and style..."
                className="w-full rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-800 outline-none focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600 transition"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-xl bg-indigo-600 py-3 text-xs font-bold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50 transition"
            >
              {loading ? "Submitting..." : "Submit application and start vetting"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
