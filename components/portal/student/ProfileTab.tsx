"use client";

import { useState, type ReactNode } from "react";
import { toast } from "react-hot-toast";
import {
  ageFromBirthDate,
  formatIsraelDateTime,
  formatIsraelDay,
  PROFILE_FIELD_LABELS,
  STUDENT_STATUS_OPTIONS,
  type ProfileTabData,
  type StudentPortalViewer,
  type StudentProfileFields,
} from "../../../lib/student-portal-shared";
import { eyebrow, fieldClass, frostPanel, primaryCta, secondaryCta } from "../../../lib/ui";

export type StatusSnapshot = { studentStatus: string[]; statusUpdatedAt: string | null };

type ProfileTabProps = {
  studentId: string;
  profile: ProfileTabData;
  viewer: StudentPortalViewer;
  /** Status change made on another tab (e.g. an absence follow-up); applied when the reference changes. */
  externalStatus?: StatusSnapshot | null;
  onStatusChange?: (snapshot: StatusSnapshot) => void;
};

type ApiResponse<T> = { success: boolean; data?: T; error?: string };

const PERSONAL_EDIT_KEYS = ["firstName", "lastName", "grade", "studyGroup", "nationalId", "city", "birthDate"] as const;
const INVOICE_EDIT_KEYS = ["invoiceName", "invoiceTaxId"] as const;

type EditableKey = (typeof PERSONAL_EDIT_KEYS)[number] | (typeof INVOICE_EDIT_KEYS)[number];
type EditForm = Record<EditableKey, string>;

function toForm(profile: StudentProfileFields): EditForm {
  const keys = [...PERSONAL_EDIT_KEYS, ...INVOICE_EDIT_KEYS];
  return Object.fromEntries(keys.map((key) => [key, profile[key] ?? ""])) as EditForm;
}

function WhatsAppButton({ url, label }: { url: string | null; label: string }) {
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      className="inline-flex items-center rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium px-3 py-1 transition-colors"
    >
      WhatsApp
    </a>
  );
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2">
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd className="text-sm font-medium text-neutral-900 min-h-5">{children ?? "—"}</dd>
    </div>
  );
}

function orDash(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

export default function ProfileTab({
  studentId,
  profile: initialProfile,
  viewer,
  externalStatus = null,
  onStatusChange,
}: ProfileTabProps) {
  const [profile, setProfile] = useState(initialProfile);
  const [appliedExternal, setAppliedExternal] = useState(externalStatus);
  if (externalStatus !== appliedExternal) {
    setAppliedExternal(externalStatus);
    if (externalStatus) setProfile((p) => ({ ...p, ...externalStatus }));
  }
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<EditForm>(() => toForm(initialProfile));
  const [saving, setSaving] = useState(false);
  const [statusSaving, setStatusSaving] = useState(false);

  const patchProfile = async <T,>(payload: object): Promise<ApiResponse<T>> => {
    const res = await fetch(`/api/portal/students/${encodeURIComponent(studentId)}/profile`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = (await res.json().catch(() => ({ success: false }))) as ApiResponse<T>;
    return res.ok ? json : { success: false, error: json.error ?? "השמירה נכשלה" };
  };

  const toggleStatus = async (code: string) => {
    const previous = profile.studentStatus;
    const next = previous.includes(code) ? previous.filter((c) => c !== code) : [...previous, code];
    setProfile((p) => ({ ...p, studentStatus: next }));
    setStatusSaving(true);
    try {
      const result = await patchProfile<{ studentStatus: string[]; statusUpdatedAt: string | null }>({
        studentStatus: next,
      });
      if (!result.success || !result.data) throw new Error(result.error ?? "השמירה נכשלה");
      const saved = result.data;
      setProfile((p) => ({ ...p, studentStatus: saved.studentStatus, statusUpdatedAt: saved.statusUpdatedAt }));
      onStatusChange?.({ studentStatus: saved.studentStatus, statusUpdatedAt: saved.statusUpdatedAt });
    } catch (error: unknown) {
      setProfile((p) => ({ ...p, studentStatus: previous }));
      toast.error(error instanceof Error ? error.message : "השמירה נכשלה");
    } finally {
      setStatusSaving(false);
    }
  };

  const saveFields = async () => {
    setSaving(true);
    try {
      const fields = viewer.canViewBilling
        ? form
        : Object.fromEntries(PERSONAL_EDIT_KEYS.map((key) => [key, form[key]]));
      const result = await patchProfile({ fields });
      if (!result.success) throw new Error(result.error ?? "השמירה נכשלה");
      const cleaned = Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [key, value.trim() || null])
      ) as Partial<StudentProfileFields>;
      setProfile((p) => {
        const next = { ...p, ...cleaned };
        return { ...next, age: ageFromBirthDate(next.birthDate) };
      });
      setEditing(false);
      toast.success("הפרטים נשמרו");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "השמירה נכשלה");
    } finally {
      setSaving(false);
    }
  };

  const editInput = (key: EditableKey) => (
    <label key={key} className="flex flex-col gap-1">
      <span className="text-xs text-neutral-500">{PROFILE_FIELD_LABELS[key]}</span>
      <input
        type={key === "birthDate" ? "date" : "text"}
        inputMode={key === "nationalId" || key === "invoiceTaxId" ? "numeric" : undefined}
        className={fieldClass}
        value={form[key]}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
      />
    </label>
  );

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <section className={`${frostPanel} p-5 lg:col-span-2 space-y-4`} aria-labelledby="personal-title">
        <div className="flex items-center justify-between gap-3">
          <h2 id="personal-title" className={eyebrow}>
            פרטים אישיים
          </h2>
          {viewer.canEditProfile && !editing && (
            <button
              type="button"
              className="text-xs font-medium text-neutral-600 hover:text-neutral-900 underline underline-offset-4"
              onClick={() => {
                setForm(toForm(profile));
                setEditing(true);
              }}
            >
              עריכת פרטים
            </button>
          )}
        </div>

        {editing ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{PERSONAL_EDIT_KEYS.map(editInput)}</div>
            {viewer.canViewBilling && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{INVOICE_EDIT_KEYS.map(editInput)}</div>
            )}
            <div className="flex gap-3">
              <button type="button" className={primaryCta} onClick={saveFields} disabled={saving}>
                {saving ? "שומרים..." : "שמירה"}
              </button>
              <button type="button" className={secondaryCta} onClick={() => setEditing(false)} disabled={saving}>
                ביטול
              </button>
            </div>
          </div>
        ) : (
          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-6">
            <InfoRow label="שם פרטי">{orDash(profile.firstName)}</InfoRow>
            <InfoRow label="שם משפחה">{orDash(profile.lastName)}</InfoRow>
            <InfoRow label="טלפון">
              <span className="flex items-center gap-2 flex-wrap">
                <span dir="ltr">{profile.phone}</span>
                <WhatsAppButton url={profile.whatsappUrl} label="פתיחת שיחת WhatsApp עם התלמיד" />
              </span>
            </InfoRow>
            <InfoRow label="כיתה">{orDash(profile.grade)}</InfoRow>
            <InfoRow label="הקבצה">{orDash(profile.studyGroup)}</InfoRow>
            <InfoRow label="אימייל">
              <span dir="ltr">{orDash(profile.email)}</span>
            </InfoRow>
            <InfoRow label="ת.ז / ח.פ">{orDash(profile.nationalId)}</InfoRow>
            <InfoRow label="עיר">{orDash(profile.city)}</InfoRow>
            <InfoRow label="תאריך לידה">
              {profile.birthDate ? formatIsraelDay(`${profile.birthDate}T12:00:00Z`) : "—"}
            </InfoRow>
            <InfoRow label="גיל">{orDash(profile.age)}</InfoRow>
            <InfoRow label="בית ספר">{orDash(profile.schoolName)}</InfoRow>
          </dl>
        )}
      </section>

      <section className={`${frostPanel} p-5 space-y-3`} aria-labelledby="status-title">
        <h2 id="status-title" className={eyebrow}>
          סטטוס לקוח
        </h2>
        <ul className="grid grid-cols-2 gap-2">
          {STUDENT_STATUS_OPTIONS.map((option) => {
            const checked = profile.studentStatus.includes(option.code);
            return (
              <li key={option.code}>
                <label
                  className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-colors ${
                    checked ? "border-neutral-900 bg-neutral-900/5" : "border-neutral-200 bg-white/60"
                  } ${viewer.canEditProfile ? "cursor-pointer" : "cursor-default opacity-80"}`}
                >
                  <input
                    type="checkbox"
                    className="accent-neutral-900"
                    checked={checked}
                    disabled={!viewer.canEditProfile || statusSaving}
                    onChange={() => toggleStatus(option.code)}
                  />
                  {option.label}
                </label>
              </li>
            );
          })}
        </ul>
        {profile.statusUpdatedAt && (
          <p className="text-xs text-neutral-400">עודכן {formatIsraelDateTime(profile.statusUpdatedAt)}</p>
        )}
      </section>

      <section className={`${frostPanel} p-5 lg:col-span-3 space-y-2`} aria-labelledby="parent-title">
        <h2 id="parent-title" className={eyebrow}>
          פרטי הורה
        </h2>
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-6">
          <InfoRow label="שם הורה">{orDash(profile.parentName)}</InfoRow>
          <InfoRow label="טלפון הורה">
            {profile.parentPhone ? (
              <span className="flex items-center gap-2 flex-wrap">
                <span dir="ltr">{profile.parentPhone}</span>
                <WhatsAppButton url={profile.parentWhatsappUrl} label="פתיחת שיחת WhatsApp עם ההורה" />
              </span>
            ) : (
              "—"
            )}
          </InfoRow>
          {viewer.canViewBilling && (
            <>
              <InfoRow label="שם מלא לחשבונית">{orDash(profile.invoiceName)}</InfoRow>
              <InfoRow label="ת.ז / ח.פ לחשבונית">{orDash(profile.invoiceTaxId)}</InfoRow>
            </>
          )}
        </dl>
      </section>
    </div>
  );
}
