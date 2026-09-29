"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "react-hot-toast";
import type { IntakeCandidate } from "../../../lib/intake-queue";
import { parseIntakeAssessment } from "../../../lib/intake-assessment";
import {
  buildIntakePayload,
  EMPTY_INTAKE_FORM,
  formatIsraelDate,
  INTAKE_KIND_LABELS,
  PARENT_INTAKE_FIELDS,
  STUDENT_INTAKE_FIELDS,
  type IntakeFieldDef,
  type IntakeFormState,
} from "../../../lib/intake-form";
import {
  badgeNeutral,
  emptyState,
  eyebrow,
  fieldClass,
  frostCard,
  frostPanel,
  primaryCta,
  secondaryCta,
} from "../../../lib/ui";

type IntakeWorkspaceProps = {
  candidates: IntakeCandidate[];
  initialKey: string | null;
};

type Tab = "student" | "parent";

type SaveResponse = { success?: boolean; error?: string };

const TABS: { id: Tab; label: string; fields: readonly IntakeFieldDef[] }[] = [
  { id: "student", label: "שאלון תלמיד", fields: STUDENT_INTAKE_FIELDS },
  { id: "parent", label: "שאלון הורה", fields: PARENT_INTAKE_FIELDS },
];

const candidateKey = (c: IntakeCandidate) => `${c.kind}:${c.id}`;

const choiceClass = (active: boolean) =>
  `rounded-full px-4 py-1.5 text-xs font-medium border transition-colors ${
    active
      ? "bg-neutral-900 text-white border-neutral-900"
      : "bg-white/60 text-neutral-700 border-neutral-300 hover:border-neutral-500"
  }`;

function matchesQuery(candidate: IntakeCandidate, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const digits = q.replace(/\D/g, "");
  return (
    candidate.name.toLowerCase().includes(q) ||
    (digits.length > 0 && candidate.phone.replace(/\D/g, "").includes(digits))
  );
}

type IntakeFieldProps = {
  def: IntakeFieldDef;
  value: string;
  onChange: (value: string) => void;
};

function IntakeField({ def, value, onChange }: IntakeFieldProps) {
  const id = `intake-${def.key}`;
  const label = (
    <label htmlFor={id} className="text-xs font-semibold text-neutral-600 block mb-1.5 text-start">
      {def.label}
      {def.required && (
        <span className="text-red-500 ms-1" aria-hidden="true">
          *
        </span>
      )}
    </label>
  );

  if (def.kind === "yesno" || def.kind === "rating") {
    const options: { value: string; label: string }[] =
      def.kind === "yesno"
        ? [
            { value: "yes", label: "כן" },
            { value: "no", label: "לא" },
          ]
        : ["1", "2", "3", "4", "5"].map((n) => ({ value: n, label: n }));
    return (
      <div>
        <span id={id} className="text-xs font-semibold text-neutral-600 block mb-1.5 text-start">
          {def.label}
          {def.required && (
            <span className="text-red-500 ms-1" aria-hidden="true">
              *
            </span>
          )}
        </span>
        <div role="radiogroup" aria-labelledby={id} aria-required={def.required} className="flex flex-wrap gap-2">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={value === option.value}
              onClick={() => onChange(value === option.value && !def.required ? "" : option.value)}
              className={choiceClass(value === option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (def.kind === "textarea") {
    return (
      <div className="sm:col-span-2">
        {label}
        <textarea
          id={id}
          rows={3}
          aria-required={def.required}
          placeholder={def.placeholder}
          className={fieldClass}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    );
  }

  const listId = def.suggestions ? `${id}-options` : undefined;
  return (
    <div>
      {label}
      <input
        id={id}
        type={def.kind === "number" ? "number" : def.kind === "date" ? "date" : "text"}
        inputMode={def.kind === "number" ? "decimal" : undefined}
        min={def.min}
        max={def.max}
        step={def.step}
        dir={def.kind === "date" ? "ltr" : undefined}
        list={listId}
        aria-required={def.required}
        placeholder={def.placeholder}
        className={fieldClass}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {def.suggestions && listId && (
        <datalist id={listId}>
          {def.suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  );
}

export default function IntakeWorkspace({ candidates: initialCandidates, initialKey }: IntakeWorkspaceProps) {
  const [candidates, setCandidates] = useState<IntakeCandidate[]>(initialCandidates);
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(initialKey);
  const [tab, setTab] = useState<Tab>("student");
  const [form, setForm] = useState<IntakeFormState>(EMPTY_INTAKE_FORM);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedName, setSavedName] = useState<string | null>(null);

  const filtered = useMemo(
    () => candidates.filter((c) => matchesQuery(c, query)),
    [candidates, query]
  );
  const selected = candidates.find((c) => candidateKey(c) === selectedKey) ?? null;

  const selectCandidate = (candidate: IntakeCandidate) => {
    if (selectedKey !== candidateKey(candidate)) {
      setForm(EMPTY_INTAKE_FORM);
      setTab("student");
    }
    setSelectedKey(candidateKey(candidate));
    setErrors([]);
    setSavedName(null);
  };

  const updateField = (key: keyof IntakeFormState, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }) as IntakeFormState);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;

    const payload = buildIntakePayload(form, { kind: selected.kind, id: selected.id });
    const check = parseIntakeAssessment(payload);
    if (!check.ok) {
      setErrors(check.errors);
      return;
    }

    setErrors([]);
    setSaving(true);
    try {
      const response = await fetch("/api/admin/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json()) as SaveResponse;
      if (!response.ok || !data.success) {
        throw new Error(data.error || "שמירת השאלון נכשלה");
      }

      toast.success("השאלון נשמר");
      setSavedName(selected.name);
      setCandidates((prev) => prev.filter((c) => candidateKey(c) !== candidateKey(selected)));
      setSelectedKey(null);
      setForm(EMPTY_INTAKE_FORM);
    } catch (err: unknown) {
      setErrors([err instanceof Error ? err.message : "שמירת השאלון נכשלה"]);
    } finally {
      setSaving(false);
    }
  };

  const activeTab = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6">
      <aside className={`${frostPanel} lg:col-span-4 overflow-hidden self-start`} aria-label="לידים ותלמידים">
        <div className="p-4 border-b border-neutral-100 space-y-2">
          <span className={`${eyebrow} block`}>ממתינים לשיחה ({candidates.length})</span>
          <input
            type="search"
            aria-label="חיפוש לפי שם או טלפון"
            placeholder="חיפוש לפי שם או טלפון"
            className={fieldClass}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {filtered.length === 0 ? (
          <p className="p-5 text-sm text-neutral-500 text-center">
            {candidates.length === 0 ? "אין כרגע לידים שממתינים לשיחה." : "לא נמצאו תוצאות."}
          </p>
        ) : (
          <ul className="max-h-[70vh] overflow-y-auto">
            {filtered.map((candidate) => {
              const active = candidateKey(candidate) === selectedKey;
              return (
                <li key={candidateKey(candidate)}>
                  <button
                    type="button"
                    onClick={() => selectCandidate(candidate)}
                    aria-pressed={active}
                    className={`w-full text-start px-4 py-3 border-b border-neutral-100 transition-colors ${
                      active ? "bg-neutral-900 text-white" : "hover:bg-neutral-50/80"
                    }`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium truncate">{candidate.name}</span>
                      <span className={`text-xs shrink-0 ${active ? "text-neutral-300" : "text-neutral-400"}`}>
                        {formatIsraelDate(candidate.createdAt)}
                      </span>
                    </span>
                    <span className={`flex items-center justify-between gap-2 text-xs ${active ? "text-neutral-300" : "text-neutral-500"}`}>
                      <span dir="ltr">{candidate.phone}</span>
                      <span>{INTAKE_KIND_LABELS[candidate.kind]}</span>
                    </span>
                    {candidate.detail && (
                      <span className={`block text-xs truncate ${active ? "text-neutral-300" : "text-neutral-400"}`}>
                        {candidate.detail}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      <section className="lg:col-span-8">
        {savedName ? (
          <div className={`${frostCard} p-8 space-y-4 text-start`} role="status">
            <h2 className="text-xl font-semibold text-neutral-900">השאלון של {savedName} נשמר</h2>
            <p className="text-sm text-neutral-600">אפשר לעבור לשיחה הבאה או לחזור ללוח הצוות.</p>
            <div className="flex flex-wrap gap-3">
              <button type="button" className={primaryCta} onClick={() => setSavedName(null)}>
                לשיחה הבאה
              </button>
              <Link href="/portal/dashboard" className={secondaryCta}>
                חזרה ללוח הצוות
              </Link>
            </div>
          </div>
        ) : !selected ? (
          <div className={emptyState}>
            <p className="text-sm text-neutral-600">בחרו ליד או תלמיד מהרשימה כדי להתחיל את שיחת המיפוי.</p>
          </div>
        ) : (
          <form className={`${frostCard} p-6 sm:p-8 space-y-6`} onSubmit={handleSubmit} noValidate>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <span className={`${eyebrow} block mb-1`}>שיחת מיפוי</span>
                <h1 className="text-2xl font-semibold text-neutral-900">{selected.name}</h1>
                <p className="text-xs text-neutral-500" dir="ltr">
                  {selected.phone}
                </p>
              </div>
              <span className={badgeNeutral}>{INTAKE_KIND_LABELS[selected.kind]}</span>
            </div>

            <div role="tablist" aria-label="חלקי השאלון" className="flex gap-2 border-b border-neutral-100 pb-3">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`tab-${t.id}`}
                  aria-selected={tab === t.id}
                  aria-controls={`panel-${t.id}`}
                  onClick={() => setTab(t.id)}
                  className={choiceClass(tab === t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div
              role="tabpanel"
              id={`panel-${activeTab.id}`}
              aria-labelledby={`tab-${activeTab.id}`}
              className="grid grid-cols-1 sm:grid-cols-2 gap-5"
            >
              {activeTab.fields.map((def) => (
                <IntakeField
                  key={def.key}
                  def={def}
                  value={form[def.key]}
                  onChange={(value) => updateField(def.key, value)}
                />
              ))}
            </div>

            {errors.length > 0 && (
              <div role="alert" className="rounded-2xl border border-red-200 bg-red-50/80 p-4 space-y-1">
                <p className="text-sm font-semibold text-red-800">צריך להשלים כמה פרטים לפני השמירה:</p>
                <ul className="list-disc ps-5 text-xs text-red-700 space-y-0.5">
                  {errors.map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3">
              {tab === "student" ? (
                <button type="button" className={secondaryCta} onClick={() => setTab("parent")}>
                  המשך לשאלון הורה
                </button>
              ) : (
                <button type="button" className={secondaryCta} onClick={() => setTab("student")}>
                  חזרה לשאלון תלמיד
                </button>
              )}
              <button type="submit" disabled={saving} className={primaryCta}>
                {saving ? "שומרים..." : "שמירת השאלון"}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
