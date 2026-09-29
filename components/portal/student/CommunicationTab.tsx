"use client";

import { useEffect, useState } from "react";
import { toast } from "react-hot-toast";
import {
  allowedCommunicationTypes,
  canWriteCommunicationType,
  COMMUNICATION_AUTHOR_ROLE_LABELS,
  COMMUNICATION_TYPE_LABELS,
  COMMUNICATION_TYPES,
  COURSE_CONTEXT_MAX,
  getCommunicationTemplate,
  isCommunicationType,
  parseCommunicationInput,
  renderCommunicationTemplate,
  setTemplateFieldValue,
  type CommunicationType,
} from "../../../lib/communication-templates";
import { formatIsraelDateTime, type CommunicationEntry } from "../../../lib/student-portal-shared";
import { badgeNeutral, emptyState, fieldClass, frostPanel, primaryCta, secondaryCta } from "../../../lib/ui";

type CommunicationTabProps = {
  studentId: string;
  entries: CommunicationEntry[];
  viewerRole: string;
  courseTitles: string[];
};

type ApiResponse<T> = { success: boolean; data?: T; error?: string };

const PREVIEW_LINES = 4;

function SummaryModal({
  studentId,
  viewerRole,
  courseTitles,
  onClose,
  onSaved,
}: {
  studentId: string;
  viewerRole: string;
  courseTitles: string[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const allowed = allowedCommunicationTypes(viewerRole);
  const [type, setType] = useState<CommunicationType>(allowed[0] ?? "GENERAL");
  const [content, setContent] = useState(() => renderCommunicationTemplate(allowed[0] ?? "GENERAL"));
  const [courseContext, setCourseContext] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  const template = getCommunicationTemplate(type);
  const choiceFields = template?.fields.filter((f) => f.kind === "choice") ?? [];

  const changeType = (next: string) => {
    if (!isCommunicationType(next) || next === type) return;
    const pristine = content.trim() === renderCommunicationTemplate(type).trim();
    if (!pristine && content.trim() && !window.confirm("להחליף תבנית? הטקסט שכתבתם יימחק.")) return;
    setType(next);
    setContent(renderCommunicationTemplate(next));
    setErrors([]);
  };

  const save = async () => {
    const payload = { type, content, courseContext: courseContext.trim() || null };
    const checked = parseCommunicationInput(payload);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors([]);
    setSaving(true);
    try {
      const res = await fetch(`/api/portal/students/${encodeURIComponent(studentId)}/communication`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json().catch(() => ({ success: false }))) as ApiResponse<CommunicationEntry>;
      if (!res.ok || !json.success) throw new Error(json.error ?? "שמירת הסיכום נכשלה");
      toast.success(`${COMMUNICATION_TYPE_LABELS[type]} נשמר`);
      await onSaved();
      onClose();
    } catch (error: unknown) {
      setErrors([error instanceof Error ? error.message : "שמירת הסיכום נכשלה"]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] bg-neutral-900/30 backdrop-blur-sm flex items-start justify-center overflow-y-auto p-4 sm:p-10"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="summary-modal-title"
        dir="rtl"
        className="w-full max-w-2xl bg-white rounded-3xl shadow-xl p-6 space-y-5"
      >
        <h2 id="summary-modal-title" className="text-lg font-semibold text-neutral-900">
          הוספת סיכום / הודעה
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-neutral-500">תבנית</span>
            <select className={fieldClass} value={type} onChange={(e) => changeType(e.target.value)}>
              {COMMUNICATION_TYPES.map((option) => (
                <option key={option} value={option} disabled={!canWriteCommunicationType(viewerRole, option)}>
                  {COMMUNICATION_TYPE_LABELS[option]}
                </option>
              ))}
            </select>
            {template && <span className="text-xs text-neutral-400">בדרך כלל ממלא/ת: {template.audience}</span>}
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-neutral-500">קורס / הקשר</span>
            <input
              className={fieldClass}
              list="course-context-options"
              maxLength={COURSE_CONTEXT_MAX}
              placeholder="למשל: שיעור מיפוי ראשוני"
              value={courseContext}
              onChange={(e) => setCourseContext(e.target.value)}
            />
            <datalist id="course-context-options">
              {courseTitles.map((title) => (
                <option key={title} value={title} />
              ))}
            </datalist>
          </label>
        </div>

        {choiceFields.length > 0 && (
          <div className="space-y-2">
            <span className="text-xs text-neutral-500">בחירה מהירה</span>
            {choiceFields.map((field) => (
              <div key={field.key} className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-neutral-700 min-w-28">{field.label}</span>
                {field.options?.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className="rounded-full border border-neutral-200 bg-white hover:bg-neutral-100 px-3 py-1 text-xs text-neutral-700 transition-colors"
                    onClick={() => setContent((c) => setTemplateFieldValue(c, type, field.key, option))}
                  >
                    {option}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}

        <label className="flex flex-col gap-1">
          <span className="text-xs text-neutral-500">תוכן</span>
          <textarea
            className={`${fieldClass} min-h-72 leading-7 font-normal`}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={type === "GENERAL" ? "כתבו כאן את ההודעה" : undefined}
          />
        </label>

        {errors.length > 0 && (
          <ul className="rounded-xl bg-red-50 border border-red-100 px-4 py-3 text-sm text-red-800 space-y-1" role="alert">
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        )}

        <div className="flex gap-3 justify-end">
          <button type="button" className={secondaryCta} onClick={onClose} disabled={saving}>
            ביטול
          </button>
          <button type="button" className={primaryCta} onClick={save} disabled={saving}>
            {saving ? "שומרים..." : "שמירה"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CommunicationTab({ studentId, entries: initialEntries, viewerRole, courseTitles }: CommunicationTabProps) {
  const [entries, setEntries] = useState(initialEntries);
  const [modalOpen, setModalOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const reload = async () => {
    try {
      const res = await fetch(`/api/portal/students/${encodeURIComponent(studentId)}/communication`, {
        cache: "no-store",
      });
      const json = (await res.json().catch(() => ({ success: false }))) as ApiResponse<CommunicationEntry[]>;
      if (!res.ok || !json.success || !json.data) throw new Error(json.error ?? "טעינת ההיסטוריה נכשלה");
      setEntries(json.data);
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "טעינת ההיסטוריה נכשלה");
    }
  };

  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section className={`${frostPanel} overflow-hidden`} aria-labelledby="communication-title">
      <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-neutral-100">
        <h2 id="communication-title" className="text-sm font-semibold text-neutral-900">
          היסטוריית תקשורת
        </h2>
        <button type="button" className={`${primaryCta} py-2`} onClick={() => setModalOpen(true)}>
          הוסף סיכום / הודעה
        </button>
      </div>

      {entries.length === 0 ? (
        <div className={`${emptyState} m-5`}>
          <p className="text-sm text-neutral-600">עדיין אין סיכומים. הסיכום הראשון יופיע כאן.</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-neutral-500 border-b border-neutral-100">
              <tr>
                <th scope="col" className="px-5 py-3 text-start font-medium whitespace-nowrap">תאריך ושעה</th>
                <th scope="col" className="px-5 py-3 text-start font-medium">סוג</th>
                <th scope="col" className="px-5 py-3 text-start font-medium">קורס / הקשר</th>
                <th scope="col" className="px-5 py-3 text-start font-medium">נכתב על ידי</th>
                <th scope="col" className="px-5 py-3 text-start font-medium w-1/2">תוכן</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const lines = entry.content.split("\n");
                const isLong = lines.length > PREVIEW_LINES;
                const isOpen = expanded.has(entry.id);
                return (
                  <tr key={entry.id} className="border-b border-neutral-100 last:border-b-0 align-top">
                    <td className="px-5 py-4 whitespace-nowrap text-neutral-700">{formatIsraelDateTime(entry.createdAt)}</td>
                    <td className="px-5 py-4">
                      <span className={badgeNeutral}>{COMMUNICATION_TYPE_LABELS[entry.type]}</span>
                    </td>
                    <td className="px-5 py-4 text-neutral-700">{entry.courseContext ?? "—"}</td>
                    <td className="px-5 py-4">
                      <span className="block text-neutral-900">{entry.authorName}</span>
                      <span className="block text-xs text-neutral-500">
                        {COMMUNICATION_AUTHOR_ROLE_LABELS[entry.authorRole] ?? ""}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-neutral-800">
                      <p className="whitespace-pre-line leading-6">
                        {isLong && !isOpen ? lines.slice(0, PREVIEW_LINES).join("\n") : entry.content}
                      </p>
                      {isLong && (
                        <button
                          type="button"
                          className="mt-1 text-xs font-medium text-neutral-500 hover:text-neutral-900 underline underline-offset-4"
                          onClick={() => toggleExpanded(entry.id)}
                        >
                          {isOpen ? "הצג פחות" : "הצג הכל"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {modalOpen && (
        <SummaryModal
          studentId={studentId}
          viewerRole={viewerRole}
          courseTitles={courseTitles}
          onClose={() => setModalOpen(false)}
          onSaved={reload}
        />
      )}
    </section>
  );
}
