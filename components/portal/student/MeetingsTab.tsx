"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { toast } from "react-hot-toast";
import { MessageCircle, Video } from "lucide-react";
import {
  formatIsraelDateTime,
  isLessonRoomOpen,
  lessonRoomHref,
  LESSON_STATUS_LABELS,
  LESSON_TYPE_LABELS,
  type AttendanceStatus,
  type MeetingRow,
  type ScheduleMeetingResult,
} from "../../../lib/student-portal-shared";
import {
  RESCHEDULE_BLOCK_LABELS,
  type CancelResult,
  type RescheduleResult,
  type SchedulePendingResult,
} from "../../../lib/lesson-lifecycle";
import { PENDING_SCHEDULE_STATUS } from "../../../lib/pedagogic-decision";
import { emptyState, frostPanel } from "../../../lib/ui";
import ScheduleMeetingModal from "./ScheduleMeetingModal";
import SchedulePendingLessonModal from "./SchedulePendingLessonModal";
import RescheduleLessonModal from "./RescheduleLessonModal";
import CancelLessonModal from "./CancelLessonModal";

type MeetingsTabProps = {
  studentId: string;
  meetings: MeetingRow[];
  /** REPRESENTATIVE / ADMIN / MANAGER may schedule, reschedule and cancel meetings. */
  canSchedule: boolean;
  /** The student is on the direct package track, so a cancelled lesson may return a credit. */
  canRestoreCredit: boolean;
};

type LifecycleModal = { kind: "pending" | "reschedule" | "cancel"; meeting: MeetingRow };

const actionButtonBase = "whitespace-nowrap rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-40";

function groupNote(whatsappDispatched: boolean): string {
  return whatsappDispatched ? " ועדכון נשלח לקבוצת הוואטסאפ" : ". העדכון לא נשלח לקבוצת הוואטסאפ, כדאי לעדכן ידנית";
}

type AttendanceResponse = {
  success: boolean;
  data?: { lessonId: string; attendanceStatus: AttendanceStatus };
  error?: string;
};

type MeetingsResponse = {
  success: boolean;
  data?: { meetings: MeetingRow[] };
  error?: string;
};

type Banner = { tone: "success" | "warning"; text: string };

const israelTime = new Intl.DateTimeFormat("he-IL", {
  timeZone: "Asia/Jerusalem",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function attendanceButtonClass(kind: AttendanceStatus, selected: boolean): string {
  const base = "rounded-full px-4 py-1.5 text-xs font-medium transition-colors disabled:opacity-40";
  if (kind === "PRESENT") {
    return selected
      ? `${base} bg-emerald-600 text-white`
      : `${base} border border-emerald-200 text-emerald-700 hover:bg-emerald-50`;
  }
  return selected
    ? `${base} bg-neutral-500 text-white`
    : `${base} border border-neutral-200 text-neutral-600 hover:bg-neutral-100`;
}

const joinButtonBase =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-4 py-1.5 text-xs font-medium transition-colors";

export function LessonRoomAction({ meeting }: { meeting: MeetingRow }) {
  if (meeting.canEnterRoom) {
    return (
      <Link
        href={lessonRoomHref(meeting.id)}
        className={`${joinButtonBase} bg-emerald-600 text-white hover:bg-emerald-700`}
      >
        <Video className="h-4 w-4" aria-hidden="true" />
        היכנס לשיעור
      </Link>
    );
  }
  const open = isLessonRoomOpen(meeting.status);
  return (
    <button
      type="button"
      disabled
      title={open ? "הכניסה פתוחה למורה של השיעור, לתלמיד ולהנהלה" : undefined}
      className={`${joinButtonBase} border border-neutral-200 text-neutral-400 cursor-not-allowed`}
    >
      <Video className="h-4 w-4" aria-hidden="true" />
      {open ? "היכנס לשיעור" : (LESSON_STATUS_LABELS[meeting.status] ?? meeting.status)}
    </button>
  );
}

function attendanceMap(meetings: MeetingRow[]): Record<string, AttendanceStatus | null> {
  return Object.fromEntries(meetings.map((m) => [m.id, m.attendanceStatus]));
}

function bannerFor(result: ScheduleMeetingResult): Banner {
  const label = result.lessonType === "MAPPING" ? "שיעור המיפוי" : "השיעור";
  switch (result.groupStatus) {
    case "OPENED":
      return { tone: "success", text: `${label} תואם בהצלחה וקבוצת הוואטסאפ הוקמה` };
    case "EXISTING":
      return result.groupUpdateSent
        ? { tone: "success", text: `${label} תואם בהצלחה ועדכון נשלח לקבוצת הוואטסאפ` }
        : { tone: "warning", text: `${label} נקבע, אבל העדכון לא נשלח לקבוצת הוואטסאפ. כדאי לעדכן בקבוצה ידנית.` };
    case "FAILED":
      return { tone: "warning", text: `${label} נקבע, אבל קבוצת הוואטסאפ לא נפתחה. אפשר לפתוח אותה ידנית.` };
    default:
      return { tone: "success", text: `${label} נקבע בהצלחה` };
  }
}

export default function MeetingsTab({
  studentId,
  meetings: initialMeetings,
  canSchedule,
  canRestoreCredit,
}: MeetingsTabProps) {
  const [meetings, setMeetings] = useState<MeetingRow[]>(initialMeetings);
  const [attendance, setAttendance] = useState<Record<string, AttendanceStatus | null>>(() =>
    attendanceMap(initialMeetings)
  );
  const [savingId, setSavingId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [lifecycleModal, setLifecycleModal] = useState<LifecycleModal | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);

  const mark = async (lessonId: string, status: AttendanceStatus) => {
    setSavingId(lessonId);
    try {
      const res = await fetch(`/api/portal/students/${encodeURIComponent(studentId)}/attendance`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lessonId, status }),
      });
      const json = (await res.json().catch(() => ({ success: false }))) as AttendanceResponse;
      if (!res.ok || !json.success || !json.data) throw new Error(json.error ?? "סימון הנוכחות נכשל");
      const saved = json.data;
      setAttendance((prev) => ({ ...prev, [saved.lessonId]: saved.attendanceStatus }));
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "סימון הנוכחות נכשל");
    } finally {
      setSavingId(null);
    }
  };

  const refreshMeetings = async () => {
    try {
      const res = await fetch(`/api/portal/students/${encodeURIComponent(studentId)}/meetings`, {
        cache: "no-store",
      });
      const json = (await res.json().catch(() => ({ success: false }))) as MeetingsResponse;
      if (!res.ok || !json.success || !json.data) throw new Error(json.error ?? "רענון המפגשים נכשל");
      setMeetings(json.data.meetings);
      setAttendance(attendanceMap(json.data.meetings));
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "רענון המפגשים נכשל");
    }
  };

  const closeModal = useCallback(() => setModalOpen(false), []);

  const handleScheduled = async (result: ScheduleMeetingResult) => {
    setModalOpen(false);
    setBanner(bannerFor(result));
    await refreshMeetings();
  };

  const closeLifecycleModal = useCallback(() => setLifecycleModal(null), []);

  const finishLifecycle = async (text: string, whatsappDispatched: boolean) => {
    setLifecycleModal(null);
    setBanner({ tone: whatsappDispatched ? "success" : "warning", text: `${text}${groupNote(whatsappDispatched)}` });
    await refreshMeetings();
  };

  const handlePendingScheduled = (result: SchedulePendingResult, whatsappDispatched: boolean) =>
    finishLifecycle(`השיעור הפרטי שובץ ל-${formatIsraelDateTime(result.scheduledAt)} עם ${result.teacherName}`, whatsappDispatched);

  const handleRescheduled = (result: RescheduleResult, whatsappDispatched: boolean) =>
    finishLifecycle(`המועד עודכן ל-${formatIsraelDateTime(result.scheduledAt)}`, whatsappDispatched);

  const handleCancelled = (result: CancelResult, whatsappDispatched: boolean) =>
    finishLifecycle(
      result.creditRestored ? `השיעור בוטל ושיעור אחד הוחזר ליתרה (${result.lessonCredits})` : "השיעור בוטל",
      whatsappDispatched
    );

  return (
    <div className="space-y-4">
      {(canSchedule || banner) && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {banner ? (
            <p
              role="status"
              className={`flex-1 rounded-xl px-4 py-2.5 text-sm font-medium ${
                banner.tone === "success" ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900"
              }`}
            >
              {banner.text}
            </p>
          ) : (
            <span />
          )}
          {canSchedule && (
            <button
              type="button"
              className="rounded-full bg-neutral-900 px-5 py-2 text-sm font-medium text-white hover:bg-neutral-800 transition-colors"
              onClick={() => setModalOpen(true)}
            >
              + הוסף מפגש
            </button>
          )}
        </div>
      )}

      {meetings.length === 0 ? (
        <div className={emptyState}>
          <p className="text-sm text-neutral-600">עדיין לא נקבעו מפגשים.</p>
        </div>
      ) : (
        <section className={`${frostPanel} overflow-x-auto`} aria-label="לוח מפגשים">
          <table className="w-full text-sm">
            <thead className="text-xs text-neutral-500 border-b border-neutral-100">
              <tr>
                <th scope="col" className="px-5 py-3 text-start font-medium">תאריך ושעה</th>
                <th scope="col" className="px-5 py-3 text-start font-medium">שיעור</th>
                <th scope="col" className="px-5 py-3 text-start font-medium">מורה</th>
                <th scope="col" className="px-5 py-3 text-start font-medium">מצב</th>
                <th scope="col" className="px-5 py-3 text-start font-medium">נוכחות</th>
                <th scope="col" className="px-5 py-3 text-start font-medium">חדר שיעור</th>
                {canSchedule && <th scope="col" className="px-5 py-3 text-start font-medium">פעולות</th>}
              </tr>
            </thead>
            <tbody>
              {meetings.map((meeting) => {
                const current = attendance[meeting.id] ?? null;
                const busy = savingId === meeting.id;
                const pending = meeting.status === PENDING_SCHEDULE_STATUS;
                return (
                  <tr key={meeting.id} className="border-b border-neutral-100 last:border-b-0">
                    <td className="px-5 py-4 whitespace-nowrap text-neutral-800">
                      {pending
                        ? "טרם נקבע מועד"
                        : `${formatIsraelDateTime(meeting.scheduledAt)}–${israelTime.format(new Date(meeting.endsAt))}`}
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-neutral-900">{meeting.title}</span>
                        {pending && (
                          <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-900">
                            ש.פ - ממתין לשיבוץ
                          </span>
                        )}
                        {meeting.lessonType === "MAPPING" && (
                          <span className="inline-flex items-center rounded-full bg-sky-50 px-2.5 py-0.5 text-xs font-medium text-sky-800">
                            {LESSON_TYPE_LABELS.MAPPING}
                          </span>
                        )}
                        {meeting.whatsappLinked && (
                          <span title="קבוצת וואטסאפ מקושרת" className="inline-flex text-emerald-600">
                            <MessageCircle className="h-4 w-4" aria-label="קבוצת וואטסאפ מקושרת" role="img" />
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-4 text-neutral-700">{meeting.teacherName ?? "—"}</td>
                    <td className="px-5 py-4 text-neutral-600">
                      {LESSON_STATUS_LABELS[meeting.status] ?? meeting.status}
                    </td>
                    <td className="px-5 py-4">
                      {meeting.canMarkAttendance ? (
                        <div className="flex gap-2" role="group" aria-label="סימון נוכחות">
                          <button
                            type="button"
                            aria-pressed={current === "PRESENT"}
                            className={attendanceButtonClass("PRESENT", current === "PRESENT")}
                            disabled={busy}
                            onClick={() => mark(meeting.id, "PRESENT")}
                          >
                            נוכח
                          </button>
                          <button
                            type="button"
                            aria-pressed={current === "ABSENT"}
                            className={attendanceButtonClass("ABSENT", current === "ABSENT")}
                            disabled={busy}
                            onClick={() => mark(meeting.id, "ABSENT")}
                          >
                            לא נוכח
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-neutral-400">
                          {current === "PRESENT" ? "נוכח" : current === "ABSENT" ? "לא נוכח" : "—"}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-4">
                      <LessonRoomAction meeting={meeting} />
                    </td>
                    {canSchedule && (
                      <td className="px-5 py-4">
                        <div className="flex flex-wrap gap-2">
                          {meeting.canSchedulePending && (
                            <button
                              type="button"
                              className={`${actionButtonBase} bg-emerald-600 text-white hover:bg-emerald-700`}
                              onClick={() => setLifecycleModal({ kind: "pending", meeting })}
                            >
                              שבץ מועד
                            </button>
                          )}
                          {(meeting.canReschedule || meeting.rescheduleBlock) && (
                            <button
                              type="button"
                              className={`${actionButtonBase} border border-neutral-300 text-neutral-800 hover:bg-white/70`}
                              disabled={!meeting.canReschedule}
                              title={meeting.rescheduleBlock ? RESCHEDULE_BLOCK_LABELS[meeting.rescheduleBlock] : undefined}
                              onClick={() => setLifecycleModal({ kind: "reschedule", meeting })}
                            >
                              שנה מועד
                            </button>
                          )}
                          {meeting.canCancel && (
                            <button
                              type="button"
                              className={`${actionButtonBase} border border-red-200 text-red-700 hover:bg-red-50`}
                              onClick={() => setLifecycleModal({ kind: "cancel", meeting })}
                            >
                              בטל שיעור
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {modalOpen && (
        <ScheduleMeetingModal studentId={studentId} onClose={closeModal} onScheduled={handleScheduled} />
      )}
      {lifecycleModal?.kind === "pending" && (
        <SchedulePendingLessonModal
          studentId={studentId}
          meeting={lifecycleModal.meeting}
          onClose={closeLifecycleModal}
          onDone={handlePendingScheduled}
        />
      )}
      {lifecycleModal?.kind === "reschedule" && (
        <RescheduleLessonModal
          studentId={studentId}
          meeting={lifecycleModal.meeting}
          onClose={closeLifecycleModal}
          onDone={handleRescheduled}
        />
      )}
      {lifecycleModal?.kind === "cancel" && (
        <CancelLessonModal
          studentId={studentId}
          meeting={lifecycleModal.meeting}
          canRestoreCredit={canRestoreCredit}
          onClose={closeLifecycleModal}
          onDone={handleCancelled}
        />
      )}
    </div>
  );
}
